import type { INestApplication } from '@nestjs/common'
import { ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { AppModule } from '../../src/infrastructure/bootstrap/app.module'
import {
  TOKEN_VERIFIER,
  Role,
  TokenVerificationError,
} from '../../src/application/ports/TokenVerifierPort'
import { CLOCK } from '../../src/application/ports/ClockPort'
import { COMBAT_RECORD } from '../../src/application/ports/CombatRecordPort'
import { COMBAT_ROOM_COMMANDS } from '../../src/application/ports/CombatRoomCommandPort'
import { TOURNAMENT_ENCOUNTER_REPOSITORY } from '../../src/application/ports/TournamentEncounterRepositoryPort'
import { MATCH_ACCEPTANCE } from '../../src/application/use-cases/MatchAcceptance'
import { PROGRESSIONS } from '../../src/application/use-cases/Progressions'
import { REGISTRATIONS } from '../../src/application/use-cases/Registrations'
import { AcceptanceReconciler } from '../../src/infrastructure/scheduling/acceptance-reconciler'
import { LifecycleReconciler } from '../../src/infrastructure/scheduling/lifecycle-reconciler'
import { acceptanceFixture } from '../support/acceptance-fixture'

describe('Calendario y aceptación HTTP v3; JWT controlado, sin cuentas reales', () => {
  let app: INestApplication, f: Awaited<ReturnType<typeof acceptanceFixture>>, subject: string
  const env = {
    AUTH_MODE: 'jwt',
    COGNITO_USER_POOL_ID: 'us-east-1_controlado',
    COGNITO_CLIENT_ID: 'test-client',
    PERSISTENCE_DRIVER: 'memory',
  }
  let previous: Record<string, string | undefined>
  beforeAll(() => {
    previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
    Object.assign(process.env, env)
  })
  afterAll(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
  })
  beforeEach(async () => {
    f = await acceptanceFixture()
    subject = f.b.seeds[0]!.memberIds[0]!
    const members = new Set(f.b.seeds.flatMap((s) => s.memberIds))
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue({
        verify: (token: string) => {
          if (!members.has(token) && !['outsider', 'admin'].includes(token))
            return Promise.reject(new TokenVerificationError())
          return Promise.resolve({
            subject: token,
            email: null,
            roles: new Set([token === 'admin' ? Role.Administrator : Role.Player]),
          })
        },
      })
      .overrideProvider(CLOCK)
      .useValue(f.clock)
      .overrideProvider(REGISTRATIONS)
      .useValue(f.registrations)
      .overrideProvider(PROGRESSIONS)
      .useValue(f.progress)
      .overrideProvider(MATCH_ACCEPTANCE)
      .useValue(f.acceptance)
      .overrideProvider(TOURNAMENT_ENCOUNTER_REPOSITORY)
      .useValue(f.encounters)
      .overrideProvider(COMBAT_RECORD)
      .useValue(f.record)
      .overrideProvider(COMBAT_ROOM_COMMANDS)
      .useValue(f.commands)
      .overrideProvider(AcceptanceReconciler)
      .useValue({})
      .overrideProvider(LifecycleReconciler)
      .useValue({})
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
  const url = (label = 'E1') =>
    `/api/v1/tournaments/${f.id}/matches/${encodeURIComponent(f.e(label).encounterId)}`
  const accept = (token = subject, body: object = { operationId: 'accept' }) =>
    request(app.getHttpServer())
      .post(url() + '/acceptance')
      .set('Authorization', 'Bearer ' + token)
      .send(body)
  const detail = (token = subject, label = 'E1') =>
    request(app.getHttpServer())
      .get(url(label))
      .set('Authorization', 'Bearer ' + token)
  it('identifica jugador por JWT, exige pertenencia y rechaza campos de actor, héroe, conteos y ready', async () => {
    expect(
      (
        await request(app.getHttpServer())
          .post(url() + '/acceptance')
          .send({ operationId: 'x' })
      ).status,
    ).toBe(401)
    f.setOpen()
    expect((await accept('admin')).status).toBe(403)
    expect((await accept('outsider')).status).toBe(403)
    for (const field of ['subject', 'teamId', 'heroId', 'acceptedCounts', 'ready', 'acceptedAt']) {
      expect((await accept(subject, { operationId: 'x', [field]: subject })).status).toBe(400)
    }
    expect((await f.store.read(f.id, f.e().encounterId))?.acceptances ?? []).toEqual([])
    expect(f.commands.createRoom).not.toHaveBeenCalled()
  })
  it('antes de apertura devuelve código preciso; recibos y replays tienen deadline servidor y no duplican', async () => {
    expect((await accept()).body.code).toBe('ACCEPTANCE_NOT_OPEN')
    f.setOpen()
    const a = await accept(),
      b = await accept()
    expect(a.status).toBe(200)
    expect(a.body).toMatchObject({
      subject,
      acceptedAt: f.window().acceptanceOpensAt,
      acceptanceClosesAt: f.window().acceptanceClosesAt,
      replayed: false,
    })
    expect(b.body).toEqual({ ...a.body, replayed: true })
    const own = await detail(),
      foreign = await detail(f.b.seeds[1]!.memberIds[0])
    expect(own.body).toMatchObject({
      contractVersion: 'torneos-v3.0.0',
      tournamentMode: 'TRIO',
      teamSize: 3,
      acceptanceStatus: 'OPEN',
      acceptedCounts: [1, 0],
      myAcceptance: { receiptId: a.body.receiptId },
    })
    expect(foreign.body.myAcceptance).toBeNull()
    expect(foreign.body.acceptedSubjects).toBeUndefined()
    expect(foreign.body.acceptance).toBeUndefined()
    f.setClose()
    expect((await accept(f.b.seeds[1]!.memberIds[0], { operationId: 'late' })).body.code).toBe(
      'ACCEPTANCE_CLOSED',
    )
  })
  it('la única consulta matches devuelve resolución ABSENCE sin sala, héroes ni eventos; no permite admin combatirla', async () => {
    f.setOpen()
    await accept()
    f.setClose()
    await f.reconciliation.run(f.id, f.e().encounterId)
    const d = await detail()
    expect(d.body).toMatchObject({
      status: 'FINISHED',
      closedAt: f.window().acceptanceClosesAt,
      combatRoomId: null,
      startedAt: null,
      result: null,
      events: [],
      teams: [],
      acceptanceStatus: 'RESOLVED',
      operationalStatus: 'FINISHED',
      resolution: {
        resultType: 'ABSENCE',
        acceptedCounts: [1, 0],
        ruleApplied: 'HIGHER_ACCEPTANCE_COUNT',
        tieBreak: null,
      },
    })
    expect(d.body.resolution.combatRoomId).toBeUndefined()
    const all = await request(app.getHttpServer())
      .get(`/api/v1/tournaments/${f.id}/matches`)
      .set('Authorization', 'Bearer ' + subject)
    expect(all.body).toHaveLength(14)
    const matches = all.body as { encounterId: string; bracketLabel: string; sources: unknown[] }[]
    expect(matches.find((m) => m.bracketLabel === 'E9')!.sources).toEqual([
      { kind: 'LOSER', matchId: 'E6' },
      { kind: 'WINNER', matchId: 'E7' },
    ])
    const admin = await request(app.getHttpServer())
      .post(`/api/v1/tournaments/admin/${f.id}/matches/${f.e().encounterId}/prepare`)
      .set('Authorization', 'Bearer admin')
      .send({ operationId: 'bypass' })
    expect(admin.status).toBe(409)
    expect(f.commands.createRoom).not.toHaveBeenCalled()
  })
  it('un intento HTTP interrumpido queda visible al cierre sin publicar sujetos pendientes ni fabricar ganador', async () => {
    f.setOpen()
    const write = f.store.change.bind(f.store)
    jest
      .spyOn(f.store, 'change')
      .mockImplementationOnce(write)
      .mockRejectedValueOnce(new Error('Escritura interrumpida'))
    expect((await accept()).status).toBe(500)
    f.setClose()
    await f.worker().run(f.id, f.e().encounterId)
    const d = await detail()
    expect(d.body).toMatchObject({
      acceptanceStatus: 'BLOCKED_DELAY',
      operationalStatus: 'DEPENDENCY_ERROR',
      acceptedCounts: [0, 0],
      resolution: null,
      winnerTeamId: null,
      loserTeamId: null,
      blockReason: { code: 'ACCEPTANCE_SERVICE_INTERRUPTED', responsible: 'TOURNAMENT_OPERATIONS' },
    })
    expect(d.body.pendingAcceptances).toBeUndefined()
    expect(f.random.bit).not.toHaveBeenCalled()
    expect(f.commands.createRoom).not.toHaveBeenCalled()
  })
  it('falta de dependencias expone bloqueo seguro con responsable; GET no abre ni reprograma', async () => {
    f.setOpen(2)
    await f.reconciliation.run(f.id, f.e('E5').encounterId)
    const before = await f.store.read(f.id, f.e('E5').encounterId),
      d = await detail(subject, 'E5')
    expect(d.body).toMatchObject({
      acceptanceStatus: 'BLOCKED_DELAY',
      operationalStatus: 'DEPENDENCY_ERROR',
      resolution: null,
      acceptedCounts: [0, 0],
      blockReason: {
        code: 'PREVIOUS_RESULT_PENDING',
        responsible: 'TOURNAMENT_OPERATIONS',
        since: f.window(2).acceptanceOpensAt,
      },
    })
    expect(await f.store.read(f.id, f.e('E5').encounterId)).toEqual(before)
    expect(d.body.acceptanceOpensAt).toBe(f.window(2).acceptanceOpensAt)
    expect(f.random.bit).not.toHaveBeenCalled()
  })
})
