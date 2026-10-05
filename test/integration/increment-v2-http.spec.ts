import type { INestApplication } from '@nestjs/common'
import { ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { AppModule } from '../../src/infrastructure/bootstrap/app.module'
import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
} from '../../src/application/ports/TokenVerifierPort'
import { CLOCK } from '../../src/application/ports/ClockPort'
import { REGISTRATIONS } from '../../src/application/use-cases/Registrations'
import { TOURNAMENT_ENCOUNTER_REPOSITORY } from '../../src/application/ports/TournamentEncounterRepositoryPort'
import { fixture, CARD, MIXED_POLICY, FREE_POLICY } from '../support/registration-fixture'

describe('API combinada v2: JWT controlado, roles, recibos y HU-83', () => {
  let app: INestApplication
  let f: ReturnType<typeof fixture>
  let previous: Record<string, string | undefined>
  const values = {
    AUTH_MODE: 'jwt',
    COGNITO_USER_POOL_ID: 'us-east-1_controlado',
    COGNITO_CLIENT_ID: 'test-client',
    PERSISTENCE_DRIVER: 'memory',
  }
  beforeAll(() => {
    previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
    Object.assign(process.env, values)
  })
  afterAll(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
  })
  beforeEach(async () => {
    f = fixture(undefined, MIXED_POLICY)
    const verifier = {
      verify: (token: string) => {
        if (!/^(?:p\d+|q\d+|admin|super|outsider)$/u.test(token))
          return Promise.reject(new TokenVerificationError())
        return Promise.resolve({
          subject: token,
          email: null,
          roles: new Set([
            token === 'admin'
              ? Role.Administrator
              : token === 'super'
                ? Role.SuperAdministrator
                : Role.Player,
          ]),
        })
      },
    }
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(verifier)
      .overrideProvider(CLOCK)
      .useValue(f.clock)
      .overrideProvider(REGISTRATIONS)
      .useValue(f.registrations)
      .overrideProvider(TOURNAMENT_ENCOUNTER_REPOSITORY)
      .useValue(f.encounters)
      .compile()
    app = module.createNestApplication()
    app.setGlobalPrefix('api')
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    )
    await app.init()
  })
  afterEach(async () => {
    await app.close()
  })
  const send = (url: string, body: object, token = 'p0') =>
    request(app.getHttpServer())
      .post('/api/v1/tournaments/' + url)
      .set('Authorization', 'Bearer ' + token)
      .send(body)
  const get = (url: string, token = 'p0') =>
    request(app.getHttpServer())
      .get('/api/v1/tournaments/' + url)
      .set('Authorization', 'Bearer ' + token)
  const create = async (policy = MIXED_POLICY) => {
    const response = await send(
      'admin',
      {
        operationId: 'create',
        name: 'Torneo HTTP',
        entryPolicy: policy,
        opensAt: '2026-10-01T00:00:00Z',
        closesAt: '2026-10-10T00:00:00Z',
        startsAt: '2026-10-12T00:00:00Z',
      },
      'admin',
    )
    expect(response.status).toBe(200)
    return response.body.id as string
  }
  const register = (id: string, n = 0) =>
    send(
      id + '/teams',
      {
        operationId: 'r' + String(n),
        name: 'Equipo ' + String(n),
        companionId: 'q' + String(n),
        avatar: { kind: 'ACCOUNT_AVATAR', subject: 'p' + String(n) },
      },
      'p' + String(n),
    )

  it('exige token válido y rol administrativo para creación/publicación', async () => {
    expect((await request(app.getHttpServer()).get('/api/v1/tournaments')).status).toBe(401)
    expect((await get('', 'inválido')).status).toBe(401)
    expect((await send('admin', {}, 'p0')).status).toBe(403)
    const id = await create()
    expect((await send('admin/' + id + '/bracket', { operationId: 'pub' }, 'p0')).status).toBe(403)
    expect((await send('admin/' + id + '/bracket', { operationId: 'pub' }, 'super')).status).toBe(
      409,
    )
  })
  it('ID administrativo lo genera el servidor y listado publica política exacta', async () => {
    const id = await create()
    expect(id).not.toBe('create')
    expect((await get('')).body[0]).toMatchObject({
      id,
      entryPolicy: MIXED_POLICY,
      entryFee: 100,
      open: true,
    })
    expect((await get(id + '/bracket')).body).toEqual({ bracket: null })
  })
  it.each([
    { ownerId: 'ajeno' },
    { memberIds: ['a', 'b', 'c'] },
    { roles: ['ADMIN'] },
    { payerId: 'ajeno' },
  ])('rechaza autoridad de actor/integrantes enviada en cuerpo %#', async (extra) => {
    const id = await create()
    const response = await send(id + '/teams', {
      operationId: 'r',
      name: 'Equipo',
      companionId: 'q0',
      avatar: { kind: 'ACCOUNT_AVATAR', subject: 'p0' },
      ...extra,
    })
    expect(response.status).toBe(400)
  })
  it('el compañero acepta desde su identidad; ningún recibo de registro afirma pago', async () => {
    const id = await create(),
      response = await register(id),
      teamId = response.body.id as string
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      ownerId: 'p0',
      status: 'AWAITING_CONSENT',
      entryReceipt: null,
      registrationReceipt: { kind: 'TEAM_REGISTRATION', status: 'REGISTERED' },
    })
    expect(
      (await send(id + '/teams/' + teamId + '/consent', { operationId: 'c', accept: true }, 'p0'))
        .status,
    ).toBe(403)
    expect(
      (await send(id + '/teams/' + teamId + '/entry', { operationId: 'pay', method: 'CREDITS' }))
        .body.code,
    ).toBe('CONSENT_REQUIRED')
    const accepted = await send(
      id + '/teams/' + teamId + '/consent',
      { operationId: 'c', accept: true },
      'q0',
    )
    expect(accepted.body.status).toBe('PENDING_PAYMENT')
    const paid = await send(id + '/teams/' + teamId + '/entry', {
      operationId: 'pay',
      method: 'CREDITS',
    })
    expect(paid.status).toBe(200)
    expect(paid.body.entryReceipt.payment.amount).toBe(100)
    expect(paid.body).not.toHaveProperty('paymentOperationId')
    expect((await get(id + '/registration', 'outsider')).body.teams).toEqual([])
  })
  it('simulado muestra recibo explícito, replay sin tarjeta y rechazo durable sin cupo', async () => {
    const id = await create(),
      team = (await register(id)).body
    await send(
      id + '/teams/' + String(team.id) + '/consent',
      { operationId: 'c', accept: true },
      'q0',
    )
    const url = id + '/teams/' + String(team.id) + '/entry'
    const declined = await send(url, {
      operationId: 'deny',
      method: 'SIMULATED_MONEY',
      card: { ...CARD, number: '4000000000000000' },
    })
    expect(declined.status).toBe(422)
    expect(declined.body.code).toBe('SIMULATED_PAYMENT_DECLINED')
    expect((await send(url, { operationId: 'deny', card: CARD })).status).toBe(422)
    const paid = await send(url, { operationId: 'pay', method: 'SIMULATED_MONEY', card: CARD })
    expect(paid.body.entryReceipt.payment).toMatchObject({
      simulated: true,
      realMoneyMoved: false,
      maskedCard: '1111',
    })
    const replay = await send(url, { operationId: 'pay' })
    expect(replay.body).toEqual(paid.body)
    for (const secret of [CARD.holder, CARD.number, CARD.expiry, CARD.securityCode])
      expect(JSON.stringify(paid.body)).not.toContain(JSON.stringify(secret))
  })
  it('rechaza tarjeta null y campos de precio/cupo impuestos por cliente', async () => {
    const id = await create(),
      team = (await register(id)).body
    await send(
      id + '/teams/' + String(team.id) + '/consent',
      { operationId: 'c', accept: true },
      'q0',
    )
    const url = id + '/teams/' + String(team.id) + '/entry'
    expect(
      (await send(url, { operationId: 'pay', method: 'SIMULATED_MONEY', card: null })).status,
    ).toBe(400)
    expect((await send(url, { operationId: 'pay', method: null })).status).toBe(400)
    expect(
      (await send(url, { operationId: 'pay', method: 'CREDITS', amount: 1, slot: 1 })).status,
    ).toBe(400)
  })
  it('siete bloquean publicación; ocho publican 14 justas mediante la única API compatible HU-83', async () => {
    const id = await create(FREE_POLICY)
    for (let n = 0; n < 8; n++) {
      if (n === 7)
        expect(
          (await send('admin/' + id + '/bracket', { operationId: 'pub' }, 'admin')).body.code,
        ).toBe('INSUFFICIENT_CONFIRMED_TEAMS')
      const team = (await register(id, n)).body
      await send(
        id + '/teams/' + String(team.id) + '/consent',
        { operationId: 'c' + String(n), accept: true },
        'q' + String(n),
      )
      expect(
        (
          await send(
            id + '/teams/' + String(team.id) + '/entry',
            { operationId: 'pay' + String(n) },
            'p' + String(n),
          )
        ).body.status,
      ).toBe('CONFIRMED')
    }
    const published = await send('admin/' + id + '/bracket', { operationId: 'pub' }, 'admin')
    expect(published.status).toBe(200)
    expect(published.body.matches).toHaveLength(14)
    const summaries = (await get(id + '/matches')).body
    expect(Array.isArray(summaries)).toBe(true)
    expect(summaries).toHaveLength(14)
    const first = summaries.find((item: { bracketLabel: string }) => item.bracketLabel === 'E1')
    const detail = await get(id + '/matches/' + encodeURIComponent(first.matchId))
    expect(detail.body).toMatchObject({
      matchId: id + ':E1',
      teams: [],
      status: 'WAITING_PARTICIPANTS',
      preparationStatus: 'TEAMS_RESOLVED',
      combatRoomId: null,
      result: null,
      events: [],
    })
    expect(detail.body.registeredTeams).toHaveLength(2)
    expect(detail.body).not.toHaveProperty('roster')
    expect((await get(id + '/registration')).body.tournament.open).toBe(false)
    expect((await get(id + '/matches/E1')).status).toBe(404)
    expect(
      (await get(id + '/matches/' + encodeURIComponent(first.matchId) + '?afterSeq=-1')).status,
    ).toBe(400)
    expect((await get('otro/matches/' + encodeURIComponent(first.matchId))).status).toBe(404)
  })
  it('torneo sin justas conserva [] y errores de registro/bracket tienen códigos de negocio', async () => {
    expect((await get('unknown/matches')).body).toEqual([])
    expect((await get('unknown/registration')).body.code).toBe('TOURNAMENT_NOT_FOUND')
    expect((await get('unknown/bracket')).body.code).toBe('TOURNAMENT_NOT_FOUND')
  })
})
