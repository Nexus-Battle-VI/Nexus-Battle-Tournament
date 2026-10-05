import { RegistrationServices } from '../../src/adapters/outbound/http/RegistrationServices'
import { HttpCombatRecordAdapter } from '../../src/adapters/outbound/combat/HttpCombatRecordAdapter'
import { signInternalRequest } from '../../src/adapters/outbound/identity/internal-signature'
import { fixture } from '../support/registration-fixture'
const response = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  )
describe('Clientes de contrato: HTTP simulado explícito y firma HMAC', () => {
  let fetchMock: jest.SpyInstance
  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch')
  })
  afterEach(() => {
    jest.restoreAllMocks()
  })
  const client = () =>
    new RegistrationServices('http://account.local', 'http://wallet.local', 'local-test-secret')
  it('firma ruta de elegibilidad con sujeto codificado y verifica el eco', async () => {
    fetchMock.mockImplementation(() =>
      response({ subject: 'a/b', displayName: 'Prueba', eligible: true }),
    )
    expect(await client().eligible('a/b')).toBe(true)
    const [url, options] = fetchMock.mock.calls[0] as [URL, RequestInit]
    expect(url.pathname).toBe('/api/internal/accounts/a%2Fb/tournament-eligibility')
    const headers = options.headers as Record<string, string>
    expect(headers['x-internal-service']).toBe('tournament')
    expect(headers['x-internal-signature']).toBe(
      signInternalRequest('local-test-secret', {
        service: 'tournament',
        method: 'GET',
        path: url.pathname,
        timestamp: headers['x-internal-timestamp']!,
        body: {},
      }),
    )
  })
  it.each([null, {}, { subject: 'otro', eligible: true }, { subject: 'p0', eligible: 'true' }])(
    'elegibilidad no acepta respuesta incompatible %#',
    async (body) => {
      fetchMock.mockImplementation(() => response(body))
      await expect(client().eligible('p0')).rejects.toMatchObject({ status: 503 })
    },
  )
  it('404 de cuenta es inelegibilidad; error de red no se convierte en elegibilidad', async () => {
    fetchMock.mockImplementation(() => response({}, 404))
    expect(await client().eligible('missing')).toBe(false)
    fetchMock.mockRejectedValue(new Error('Error con datos privados'))
    await expect(client().eligible('p0')).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      status: 503,
    })
  })
  it('valida identidad por Account y pasa solo nombre y referencia de avatar', async () => {
    fetchMock.mockImplementation(() =>
      response({
        name: 'Equipo',
        avatar: { kind: 'ACCOUNT_AVATAR', subject: 'p0' },
        policyVersion: 'account-team-identity-v1',
      }),
    )
    expect(await client().validateIdentity(' Equipo ', 'p0')).toMatchObject({ name: 'Equipo' })
    const [url, options] = fetchMock.mock.calls[0] as [URL, RequestInit]
    expect(url.pathname).toBe('/api/internal/accounts/tournament-team-identity/validation')
    expect(JSON.parse(options.body as string)).toEqual({ name: ' Equipo ', avatarSubject: 'p0' })
  })
  it.each([
    null,
    { name: 'Equipo', avatar: null },
    {
      name: 'Equipo',
      avatar: { kind: 'ACCOUNT_AVATAR', subject: 'otro' },
      policyVersion: 'account-team-identity-v1',
    },
    { name: 'Equipo', avatar: { kind: 'ACCOUNT_AVATAR', subject: 'p0' }, policyVersion: 'otra' },
  ])('identidad incompatible no se acepta %#', async (body) => {
    fetchMock.mockImplementation(() => response(body))
    await expect(client().validateIdentity('Equipo', 'p0')).rejects.toMatchObject({ status: 503 })
  })
  it.each([
    'INVALID_TEAM_NAME',
    'INVALID_TEAM_AVATAR',
    'INSUFFICIENT_BALANCE',
    'OPERATION_CONFLICT',
  ])('traduce error %s sin filtrar mensaje del proveedor', async (code) => {
    fetchMock.mockImplementation(() =>
      response({ code, message: '4111111111111111 dato privado' }, 422),
    )
    const error = await client()
      .validateIdentity('Equipo', 'p0')
      .catch((value: unknown) => value)
    expect(error).toMatchObject({ code })
    expect(String(error)).not.toContain('4111111111111111')
  })
  it('servicio no configurado, JSON roto y error desconocido fallan sin fabricar respuesta', async () => {
    await expect(
      new RegistrationServices(undefined, undefined, null).eligible('p'),
    ).rejects.toMatchObject({ status: 503 })
    fetchMock.mockImplementation(() => Promise.resolve(new Response('no-json', { status: 200 })))
    await expect(client().eligible('p')).rejects.toMatchObject({ status: 503 })
    fetchMock.mockImplementation(() => response({ code: 'PRIVATE_ERROR', message: 'secreto' }, 500))
    await expect(client().eligible('p')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  })
  it('cobro y devolución usan las rutas de tarifa, sin carrito', async () => {
    const charge = {
      operationId: 'charge',
      tournamentId: 't',
      teamId: 'team',
      payerId: 'p',
      amount: 100,
      chargeId: 'c/1',
      status: 'CHARGED',
      applied: true,
    }
    fetchMock.mockImplementation(() => response(charge))
    expect(await client().charge(charge)).toMatchObject(charge)
    await client().refund('c/1', 'refund')
    const [url, options] = fetchMock.mock.calls[1] as [URL, RequestInit]
    expect(url.pathname).toBe('/api/internal/v1/wallet/tournament-entry-fees/c%2F1/refunds')
    expect(JSON.parse(options.body as string)).toEqual({ operationId: 'refund' })
  })
  it.each(['amount', 'payerId', 'teamId', 'tournamentId', 'operationId'])(
    'eco incorrecto de Wallet (%s) conserva reserva incierta sin recibo',
    async (key) => {
      const f = fixture(),
        t = await f.create(),
        team = await f.accept(t.id)
      const charge = f.wallet.charge.bind(f.wallet)
      jest.spyOn(f.wallet, 'charge').mockImplementation(async (command) => {
        const result = await charge(command)
        return { ...result, [key]: key === 'amount' ? 1 : 'otro' }
      })
      const state = await f.registrations.enter(t.id, team.id, 'p0', { operationId: 'pay' })
      expect(state).toMatchObject({
        status: 'PAYMENT_PENDING',
        slot: 1,
        entryReceipt: null,
        failure: { code: 'PAYMENT_UNCERTAIN' },
      })
    },
  )
})
const wireRecord = () => ({
  roomId: 'room',
  tournamentId: 't',
  encounterId: 't:E1',
  status: 'IN_BATTLE',
  startedAt: '2026-10-05T12:00:00Z',
  result: null,
  teams: [
    {
      teamId: 'A',
      participants: [
        { kind: 'HUMAN', playerId: 'a1', heroId: 'ha1' },
        { kind: 'HUMAN', playerId: 'a2', heroId: 'ha2' },
      ],
    },
    {
      teamId: 'B',
      participants: [
        { kind: 'HUMAN', playerId: 'b1', heroId: 'hb1' },
        { kind: 'HUMAN', playerId: 'b2', heroId: 'hb2' },
      ],
    },
  ],
  events: {
    afterSeq: 0,
    lastSeq: 1,
    items: [
      {
        roomId: 'room',
        seq: 1,
        type: 'battleStarted',
        occurredAt: '2026-10-05T12:00:00Z',
        battle: { original: true },
      },
    ],
  },
})
describe('Lectura del DTO real de Combat contra doble HTTP explícito', () => {
  let fetchMock: jest.SpyInstance
  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch')
  })
  afterEach(() => {
    jest.restoreAllMocks()
  })
  const client = () => new HttpCombatRecordAdapter('http://combat.local', 'secret')
  it('traduce events.items y conserva BattleEventWire original como payload; firma sin query como el guard publicado', async () => {
    const wire = wireRecord()
    fetchMock.mockImplementation(() => response(wire))
    const actual = await client().readRecord('room', 0)
    expect(actual.events[0]?.payload).toEqual(wire.events.items[0])
    expect(actual.teams?.[0]?.teamLabel).toBe('A')
    const [url, options] = fetchMock.mock.calls[0] as [URL, RequestInit]
    expect(url.search).toBe('?afterSeq=0')
    const headers = options.headers as Record<string, string>
    expect(headers['x-internal-signature']).toBe(
      signInternalRequest('secret', {
        service: 'tournament',
        method: 'GET',
        path: url.pathname,
        timestamp: headers['x-internal-timestamp']!,
        body: {},
      }),
    )
  })
  it.each(['WIN', 'NO_WINNER'])('conserva resultado autoritativo %s', async (outcome) => {
    const wire = {
      ...wireRecord(),
      status: 'FINISHED',
      result: {
        winnerTeamLabel: outcome === 'WIN' ? 'A' : null,
        outcome,
        reason: 'TIME_LIMIT',
        finishedAt: '2026-10-05T12:10:00Z',
      },
    }
    fetchMock.mockImplementation(() => response(wire))
    expect((await client().readRecord('room', 0)).result?.winnerTeamLabel).toBe(
      outcome === 'WIN' ? 'A' : null,
    )
  })
  it.each([
    (wire: ReturnType<typeof wireRecord>) => ({ ...wire, roomId: 'otra' }),
    (wire: ReturnType<typeof wireRecord>) => ({ ...wire, events: { ...wire.events, afterSeq: 2 } }),
    (wire: ReturnType<typeof wireRecord>) => ({
      ...wire,
      events: { ...wire.events, items: [{ ...wire.events.items[0], seq: 3 }] },
    }),
    (wire: ReturnType<typeof wireRecord>) => ({ ...wire, events: { ...wire.events, items: [] } }),
    (wire: ReturnType<typeof wireRecord>) => ({ ...wire, teams: [wire.teams[0], wire.teams[0]] }),
    (wire: ReturnType<typeof wireRecord>) => ({
      ...wire,
      result: {
        winnerTeamLabel: 'Z',
        reason: 'ELIMINATION',
        outcome: 'WIN',
        finishedAt: '2026-10-05T12:10:00Z',
      },
      status: 'FINISHED',
    }),
  ])('rechaza sala, cursores, secuencias, roster o resultado incompatibles %#', async (corrupt) => {
    fetchMock.mockImplementation(() => response(corrupt(wireRecord())))
    await expect(client().readRecord('room', 0)).rejects.toMatchObject({ status: 503 })
  })
  it('configuración ausente y caída de Combat no generan registro ficticio', async () => {
    await expect(
      new HttpCombatRecordAdapter(undefined, null).readRecord('room', 0),
    ).rejects.toMatchObject({ status: 503 })
    fetchMock.mockImplementation(() => response({}, 503))
    await expect(client().readRecord('room', 0)).rejects.toMatchObject({ status: 503 })
  })
})
