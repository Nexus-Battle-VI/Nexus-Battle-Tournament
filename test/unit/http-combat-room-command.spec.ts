import { HttpCombatRoomCommandAdapter } from '../../src/adapters/outbound/combat/HttpCombatRoomCommandAdapter'
import { CombatRejectedError } from '../../src/domain/encounter-admin'
import { signInternalRequest } from '../../src/adapters/outbound/identity/internal-signature'

const ROOM = '3f1c2c5e-6b0f-4c0e-9d41-0a8f1d5f7b11'
const create = {
  operationId: 'tournament:t-1:E1:prepare',
  tournamentId: 't-1',
  encounterId: 't-1:E1',
  teams: [
    { teamId: 'A', memberIds: ['p0', 'q0'] },
    { teamId: 'B', memberIds: ['p1', 'q1'] },
  ],
} as const

const reply = (status: number, body: unknown): Promise<Response> =>
  Promise.resolve(new Response(JSON.stringify(body), { status }))
const urlOf = (call: readonly unknown[] | undefined): string => {
  const target = call?.[0]
  return typeof target === 'string' ? target : target instanceof URL ? target.href : ''
}

describe('HttpCombatRoomCommandAdapter (HU-85)', () => {
  const adapter = new HttpCombatRoomCommandAdapter('http://combat.test', 'secreto')
  const fetchMock = jest.spyOn(globalThis, 'fetch')
  afterEach(() => {
    fetchMock.mockReset()
  })
  afterAll(() => {
    fetchMock.mockRestore()
  })

  it('crea la sala con firma HMAC interna y devuelve su identificador', async () => {
    fetchMock.mockImplementation(() => reply(201, { id: ROOM }))
    await expect(adapter.createRoom(create)).resolves.toEqual({ roomId: ROOM })
    const init = fetchMock.mock.calls[0]?.[1]
    expect(urlOf(fetchMock.mock.calls[0])).toBe(
      'http://combat.test/api/internal/v1/combat/tournament-rooms',
    )
    const headers = init?.headers as Record<string, string>
    expect(headers['x-internal-service']).toBe('tournament')
    expect(JSON.parse(init?.body as string)).toEqual(create)
    expect(headers['x-internal-signature']).toBe(
      signInternalRequest('secreto', {
        service: 'tournament',
        method: 'POST',
        path: '/api/internal/v1/combat/tournament-rooms',
        timestamp: headers['x-internal-timestamp'] ?? '',
        body: create,
      }),
    )
  })

  it('inicia la sala indicada', async () => {
    fetchMock.mockImplementation(() => reply(200, { id: ROOM }))
    await expect(
      adapter.startRoom(ROOM, { operationId: 'o', tournamentId: 't-1', encounterId: 't-1:E1' }),
    ).resolves.toBeUndefined()
    expect(urlOf(fetchMock.mock.calls[0])).toContain(`/tournament-rooms/${ROOM}/start`)
  })

  it.each([
    { mode: 'SOLO', size: 1 },
    { mode: 'DUO', size: 2 },
    { mode: 'TRIO', size: 3 },
  ] as const)(
    '$mode traduce la modalidad interna, firma el wire real y valida roster completo',
    async ({ mode, size }) => {
      const teams = [
        { teamId: 'a', memberIds: Array.from({ length: size }, (_, i) => 'a' + String(i)) },
        { teamId: 'b', memberIds: Array.from({ length: size }, (_, i) => 'b' + String(i)) },
      ] as const
      const response = {
        id: ROOM,
        tournament: { contractVersion: 3, mode, teamSize: size },
        teams: teams.map((t) => ({
          label: t.teamId,
          capacity: size,
          participants: t.memberIds.map((playerId) => ({
            kind: 'HUMAN',
            playerId,
            heroId: 'hero-' + playerId,
          })),
        })),
      }
      fetchMock.mockImplementation(() => reply(201, response))
      await expect(
        adapter.createRoom({ ...create, tournamentMode: mode, teamSize: size, teams }),
      ).resolves.toEqual({ roomId: ROOM })
      const init = fetchMock.mock.calls[0]![1]!,
        headers = init.headers as Record<string, string>
      const wire = {
        operationId: create.operationId,
        tournamentId: create.tournamentId,
        encounterId: create.encounterId,
        mode,
        teamSize: size,
        teams,
      }
      expect(JSON.parse(init.body as string)).toEqual(wire)
      expect(headers['x-internal-signature']).toBe(
        signInternalRequest('secreto', {
          service: 'tournament',
          method: 'POST',
          path: '/api/internal/v1/combat/tournament-rooms',
          timestamp: headers['x-internal-timestamp'] ?? '',
          body: wire,
        }),
      )
      response.teams[0]!.participants[0]!.playerId = 'foreign'
      await expect(
        adapter.createRoom({ ...create, tournamentMode: mode, teamSize: size, teams }),
      ).rejects.toMatchObject({ status: 503 })
    },
  )

  it('traduce 422 con bloqueos y 422 con código sin inventar participantes', async () => {
    fetchMock.mockImplementationOnce(() =>
      reply(422, { message: 'no elegible', blockers: [{ playerId: 'p0' }] }),
    )
    await expect(adapter.createRoom(create)).rejects.toMatchObject({
      code: 'COMBAT_REJECTED_PARTICIPANTS',
      status: 422,
      blockers: [{ playerId: 'p0' }],
    })
    fetchMock.mockImplementationOnce(() => reply(422, { code: 'PLAYER_WITHOUT_EQUIPPED_HERO' }))
    const error = await adapter.createRoom(create).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CombatRejectedError)
    expect((error as CombatRejectedError).blockers).toEqual([
      { code: 'PLAYER_WITHOUT_EQUIPPED_HERO' },
    ])
    fetchMock.mockImplementationOnce(() => reply(422, null))
    expect(await adapter.createRoom(create).catch((e: unknown) => e)).toMatchObject({
      blockers: [],
    })
  })

  it('traduce 404/409 a conflicto de sala y todo lo demás a 503', async () => {
    for (const status of [404, 409])
      await expect(
        (fetchMock.mockImplementationOnce(() => reply(status, {})), adapter.createRoom(create)),
      ).rejects.toMatchObject({ code: 'COMBAT_ROOM_CONFLICT', status: 409 })
    for (const status of [500, 503, 401])
      await expect(
        (fetchMock.mockImplementationOnce(() => reply(status, {})), adapter.createRoom(create)),
      ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', status: 503 })
  })

  it('red caída, cuerpo ilegible o sala incompatible dan 503', async () => {
    fetchMock.mockImplementationOnce(() => Promise.reject(new Error('ECONNREFUSED')))
    await expect(adapter.createRoom(create)).rejects.toMatchObject({ status: 503 })
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(new Response('no-json', { status: 200 })),
    )
    await expect(adapter.createRoom(create)).rejects.toMatchObject({ status: 503 })
    fetchMock.mockImplementationOnce(() => reply(201, { id: '' }))
    await expect(adapter.createRoom(create)).rejects.toMatchObject({ status: 503 })
    fetchMock.mockImplementationOnce(() => reply(200, { id: 'otra' }))
    await expect(
      adapter.startRoom(ROOM, { operationId: 'o', tournamentId: 't-1', encounterId: 't-1:E1' }),
    ).rejects.toMatchObject({ status: 503 })
  })

  it('sin configuración no sale ninguna petición', async () => {
    await expect(
      new HttpCombatRoomCommandAdapter(undefined, 's').createRoom(create),
    ).rejects.toMatchObject({ status: 503 })
    await expect(
      new HttpCombatRoomCommandAdapter('http://x', null).createRoom(create),
    ).rejects.toMatchObject({ status: 503 })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
