import { TournamentPrizeRecipientsClient } from '../../src/adapters/outbound/http/TournamentPrizeRecipientsClient'
import { signInternalRequest } from '../../src/adapters/outbound/identity/internal-signature'
describe('HU-86: destinatario propio por contrato Inventory/HMAC', () => {
  const fetcher = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
  beforeEach(() => {
    fetcher.mockReset()
    jest.spyOn(globalThis, 'fetch').mockImplementation(fetcher)
  })
  afterEach(() => {
    jest.restoreAllMocks()
  })
  const client = () => new TournamentPrizeRecipientsClient('http://inventory', 'test-only-secret')
  it('firma como tournament el playerId exacto del campeón y valida su héroe', async () => {
    fetcher.mockResolvedValue(
      new Response(
        JSON.stringify({ playerId: 'player/opaque', heroId: 'hero-owned', ready: false }),
      ),
    )
    expect(await client().heroFor('player/opaque')).toBe('hero-owned')
    const [url, options] = fetcher.mock.calls[0]!
    if (!(url instanceof URL)) throw new Error('Expected a URL')
    expect(url.toString()).toBe(
      'http://inventory/api/internal/v1/players/player%2Fopaque/equipped-hero',
    )
    const headers = options!.headers as Record<string, string>
    expect(headers['x-internal-service']).toBe('tournament')
    expect(headers['x-internal-signature']).toBe(
      signInternalRequest('test-only-secret', {
        service: 'tournament',
        method: 'GET',
        path: url.pathname,
        timestamp: headers['x-internal-timestamp']!,
        body: {},
      }),
    )
    expect(options!.body).toBeUndefined()
  })
  it('un destinatario sin selección conserva el derecho; no inventa héroe', async () => {
    fetcher.mockResolvedValue(new Response('{}', { status: 404 }))
    expect(await client().heroFor('player')).toBeNull()
  })
  it.each([
    { playerId: 'foreign', heroId: 'hero' },
    { playerId: 'player', heroId: null },
    { playerId: 'player', heroId: '' },
    { playerId: 'player', heroId: ' hero ' },
    { playerId: 'player', heroId: 'x'.repeat(161) },
    { playerId: 'player', heroId: 'h\0x' },
  ])('rechaza datos ajenos o inválidos %#', async (data) => {
    fetcher.mockResolvedValue(new Response(JSON.stringify(data)))
    await expect(client().heroFor('player')).rejects.toMatchObject({
      code: 'PRIZE_RECIPIENT_UNAVAILABLE',
      status: 503,
    })
  })
  it('configuración incompleta, caída, JSON inválido y error HTTP no entregan éxito', async () => {
    await expect(
      new TournamentPrizeRecipientsClient(undefined, null).heroFor('player'),
    ).rejects.toMatchObject({ code: 'PRIZE_RECIPIENT_CONTRACT_REQUIRED' })
    expect(fetcher).not.toHaveBeenCalled()
    fetcher.mockRejectedValueOnce(new Error('offline'))
    await expect(client().heroFor('player')).rejects.toMatchObject({ status: 503 })
    for (const response of [new Response('invalid-json'), new Response('{}', { status: 503 })]) {
      fetcher.mockResolvedValueOnce(response)
      await expect(client().heroFor('player')).rejects.toMatchObject({ status: 503 })
    }
  })
})
