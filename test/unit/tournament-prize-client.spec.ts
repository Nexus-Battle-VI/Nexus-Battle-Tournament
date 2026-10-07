import { TournamentPrizeClient } from '../../src/adapters/outbound/http/TournamentPrizeClient'
import type { PrizeGrant } from '../../src/domain/prize'
import { signInternalRequest } from '../../src/adapters/outbound/identity/internal-signature'
import { PrizeReconciler } from '../../src/infrastructure/scheduling/prize-reconciler'
import type { Prizes } from '../../src/application/use-cases/Prizes'
const command: PrizeGrant = {
  operationId: 'op',
  tournamentId: 'T1',
  championTeamId: 'winner',
  finalEncounterId: 'T1:Final',
  finalRoomId: 'room',
  playerId: 'p',
  heroId: 'h',
  kind: 'CREDITS',
  amount: '501',
  productId: null,
}
describe('Contrato saliente HU-86: HMAC y fallo cerrado', () => {
  const fetcher = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
  beforeEach(() => {
    jest.spyOn(globalThis, 'fetch').mockImplementation(fetcher)
    fetcher.mockReset()
  })
  afterEach(() => {
    jest.restoreAllMocks()
  })
  it.each(['CREDITS', 'EPIC'] as const)(
    'firma el derecho completo y conserva el mismo cuerpo para %s',
    async (kind) => {
      const c = { ...command, kind }
      fetcher.mockResolvedValue(
        new Response(JSON.stringify({ ...c, status: 'DELIVERED', receiptId: 'receipt' })),
      )
      const client = new TournamentPrizeClient('http://wallet', 'http://inventory', 'secret')
      await client.grant(c)
      await client.grant(c)
      const [url, options] = fetcher.mock.calls[0]!
      if (!(url instanceof URL)) throw new Error('Expected a URL from the adapter')
      const path = url.pathname
      expect(path).toBe(
        kind === 'CREDITS'
          ? '/api/internal/v1/wallet/credits/tournament-prize'
          : '/api/internal/v1/inventory/tournament-prizes',
      )
      const headers = options!.headers as Record<string, string>
      expect(headers['x-internal-service']).toBe('tournament')
      expect(headers['x-internal-signature']).toBe(
        signInternalRequest('secret', {
          service: 'tournament',
          method: 'POST',
          path,
          timestamp: headers['x-internal-timestamp']!,
          body: c,
        }),
      )
      expect(fetcher.mock.calls[1]![1]!.body).toBe(options!.body)
    },
  )
  it('sin configuración/secreto, timeout, 404, 409 y 503 no produce éxito', async () => {
    await expect(
      new TournamentPrizeClient(undefined, undefined, null).grant(command),
    ).rejects.toMatchObject({ code: 'PRIZE_DESTINATION_UNAVAILABLE' })
    expect(fetcher).not.toHaveBeenCalled()
    const client = new TournamentPrizeClient('http://wallet', 'http://inventory', 'secret')
    fetcher.mockRejectedValueOnce(new Error('timeout'))
    await expect(client.grant(command)).rejects.toMatchObject({ status: 503 })
    for (const status of [404, 409, 503]) {
      fetcher.mockResolvedValueOnce(new Response('{}', { status }))
      await expect(client.grant(command)).rejects.toMatchObject({ status: 503 })
    }
    fetcher.mockResolvedValueOnce(new Response('invalid-json'))
    expect(await client.grant(command)).toBeNull()
  })
})
describe('Barrido de premios sin solapamiento', () => {
  it('dos ticks comparten el mismo barrido y esperan cierre', async () => {
    let complete: (() => void) | undefined
    const reconcile = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve
        }),
    )
    const scheduler = new PrizeReconciler({ reconcile } as unknown as Prizes)
    const a = scheduler.tick(),
      b = scheduler.tick()
    expect(reconcile).toHaveBeenCalledTimes(1)
    complete?.()
    await Promise.all([a, b])
    await scheduler.onModuleDestroy()
    const rejected = new PrizeReconciler({
      reconcile: () => Promise.reject(new Error('db down')),
    } as unknown as Prizes)
    await expect(rejected.tick()).resolves.toBeUndefined()
  })
  it('intervalo activado ejecuta y se detiene; 0 permanece apagado', async () => {
    jest.useFakeTimers()
    const before = process.env.PRIZE_RECONCILE_INTERVAL_MS
    const reconcile = jest.fn(() => Promise.resolve())
    try {
      process.env.PRIZE_RECONCILE_INTERVAL_MS = '0'
      const off = new PrizeReconciler({ reconcile } as unknown as Prizes)
      off.onModuleInit()
      expect(reconcile).not.toHaveBeenCalled()
      process.env.PRIZE_RECONCILE_INTERVAL_MS = '5000'
      const on = new PrizeReconciler({ reconcile } as unknown as Prizes)
      on.onModuleInit()
      await jest.advanceTimersByTimeAsync(5000)
      expect(reconcile).toHaveBeenCalledTimes(2)
      await on.onModuleDestroy()
      await jest.advanceTimersByTimeAsync(5000)
      expect(reconcile).toHaveBeenCalledTimes(2)
    } finally {
      if (before === undefined) delete process.env.PRIZE_RECONCILE_INTERVAL_MS
      else process.env.PRIZE_RECONCILE_INTERVAL_MS = before
      jest.useRealTimers()
    }
  })
})
