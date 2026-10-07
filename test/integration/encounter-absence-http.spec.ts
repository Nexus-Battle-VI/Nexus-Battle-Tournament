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
import { COMBAT_RECORD } from '../../src/application/ports/CombatRecordPort'
import { COMBAT_ROOM_COMMANDS } from '../../src/application/ports/CombatRoomCommandPort'
import { REGISTRATIONS } from '../../src/application/use-cases/Registrations'
import { TOURNAMENT_ENCOUNTER_REPOSITORY } from '../../src/application/ports/TournamentEncounterRepositoryPort'
import { ENCOUNTER_ABSENCES } from '../../src/application/use-cases/EncounterAbsences'
import type { EncounterAbsences } from '../../src/application/use-cases/EncounterAbsences'
import { fixture } from '../support/registration-fixture'
import { FakeCombat } from '../support/fake-combat'

/**
 * Decisión de Carlos sobre HU-85: hora programada, ventana de aceptación de dos
 * minutos, equipo listo = todos sus integrantes, avance por ausencia como
 * victoria normal registrada aparte. El torneo empieza 2026-10-12T00:00:00Z y
 * E1 enfrenta a (p0,q0) contra (p1,q1); E2 a (p2,q2) contra (p3,q3), etc.
 */
describe('HU-85: ventana de aceptación y avance por ausencia', () => {
  let app: INestApplication
  let f: ReturnType<typeof fixture>
  let combat: FakeCombat
  let tid: string
  let absences: EncounterAbsences
  const env = {
    AUTH_MODE: 'jwt',
    COGNITO_USER_POOL_ID: 'us-east-1_controlado',
    COGNITO_CLIENT_ID: 'test-client',
    PERSISTENCE_DRIVER: 'memory',
    ABSENCE_RESOLVER_ENABLED: 'false',
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
    f = fixture()
    combat = new FakeCombat()
    const verifier = {
      verify: (token: string) =>
        /^(?:[pq]\d+|admin)$/u.test(token)
          ? Promise.resolve({
              subject: token,
              email: null,
              roles: new Set([token === 'admin' ? Role.Administrator : Role.Player]),
            })
          : Promise.reject(new TokenVerificationError()),
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
      .overrideProvider(COMBAT_ROOM_COMMANDS)
      .useValue(combat)
      .overrideProvider(COMBAT_RECORD)
      .useValue(combat)
      .compile()
    app = module.createNestApplication()
    app.setGlobalPrefix('api')
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    )
    await app.init()
    absences = app.get<EncounterAbsences>(ENCOUNTER_ABSENCES)
    tid = (await f.create()).id
    for (let n = 0; n < 8; n += 1) await f.confirm(tid, n)
    await f.brackets.publish(tid, 'admin', 'pub')
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    await app.close()
  })

  const ready = (match: string, token: string) =>
    request(app.getHttpServer())
      .post(`/api/v1/tournaments/${tid}/matches/${tid}:${match}/ready`)
      .set('Authorization', 'Bearer ' + token)
  const readiness = (match: string) =>
    request(app.getHttpServer())
      .get(`/api/v1/tournaments/${tid}/matches/${tid}:${match}/readiness`)
      .set('Authorization', 'Bearer p0')
  const detail = (match: string) =>
    request(app.getHttpServer())
      .get(`/api/v1/tournaments/${tid}/matches/${tid}:${match}`)
      .set('Authorization', 'Bearer p0')
  const admin = (match: string, action: 'prepare' | 'start', operationId: string) =>
    request(app.getHttpServer())
      .post(`/api/v1/tournaments/admin/${tid}/matches/${tid}:${match}/${action}`)
      .set('Authorization', 'Bearer admin')
      .send({ operationId })

  it('la ventana abre a la hora programada y dura dos minutos', async () => {
    f.setNow('2026-10-11T23:59:59Z')
    const before = await ready('E1', 'p0')
    expect(before.status).toBe(409)
    expect(before.body.code).toBe('ACCEPTANCE_NOT_OPEN')
    const view = await readiness('E1')
    expect(view.body).toMatchObject({
      scheduledAt: '2026-10-12T00:00:00.000Z',
      acceptanceDeadline: '2026-10-12T00:02:00.000Z',
      windowOpen: false,
      resolution: null,
    })
    f.setNow('2026-10-12T00:00:00Z')
    expect((await ready('E1', 'p0')).status).toBe(200)
    f.setNow('2026-10-12T00:02:00Z')
    expect((await ready('E1', 'q0')).status).toBe(200)
    f.setNow('2026-10-12T00:02:01Z')
    const late = await ready('E1', 'p1')
    expect(late.status).toBe(409)
    expect(late.body.code).toBe('ACCEPTANCE_CLOSED')
  })

  it('solo aceptan los integrantes de los dos equipos y solo con equipos resueltos', async () => {
    f.setNow('2026-10-12T00:01:00Z')
    expect((await ready('E1', 'p5')).body.code).toBe('NOT_A_PARTICIPANT')
    expect((await ready('E1', 'admin')).status).toBe(403)
    const unresolved = await ready('E5', 'p0')
    expect(unresolved.status).toBe(409)
    expect(unresolved.body.code).toBe('PARTICIPANTS_UNRESOLVED')
    expect(
      (
        await request(app.getHttpServer()).post(
          `/api/v1/tournaments/${tid}/matches/${tid}:E1/ready`,
        )
      ).status,
    ).toBe(401)
  })

  it('un equipo está listo solo cuando aceptan todos sus integrantes; aceptar es idempotente', async () => {
    f.setNow('2026-10-12T00:01:00Z')
    await ready('E1', 'p0')
    const repeated = await ready('E1', 'p0')
    expect(repeated.body.teams[0]).toMatchObject({ ready: false })
    expect(repeated.body.teams[0].members).toEqual([
      { playerId: 'p0', accepted: true },
      { playerId: 'q0', accepted: false },
    ])
    const full = await ready('E1', 'q0')
    expect(full.body.teams[0].ready).toBe(true)
    expect(full.body.teams[1].ready).toBe(false)
  })

  it('al cerrar la ventana: gana el único equipo listo, el que tiene más jugadores listos, o se sortea', async () => {
    f.setNow('2026-10-12T00:01:00Z')
    await ready('E1', 'p0')
    await ready('E1', 'q0') // E1: equipo A completo, B nadie
    await ready('E3', 'p4') // E3: 1 jugador listo contra 0
    for (const p of ['p6', 'q6', 'p7', 'q7']) await ready('E4', p) // E4: ambos completos
    f.setNow('2026-10-12T00:02:01Z')
    jest.spyOn(Math, 'random').mockReturnValue(0.9)
    expect(await absences.sweep()).toBe(3) // E1, E2 y E3; E4 se juega
    const e1 = (await detail('E1')).body
    expect(e1).toMatchObject({
      status: 'FINISHED',
      result: { reason: 'ABSENCE', outcome: 'WIN' },
      combatRoomId: null,
    })
    const teamA = (await readiness('E1')).body.teams[0].teamId as string
    expect(e1.result.winnerTeamLabel).toBe(teamA)
    expect((await readiness('E1')).body.resolution).toMatchObject({
      kind: 'ONE_TEAM_READY',
      winnerTeamId: teamA,
      readyCounts: [2, 0],
    })
    const e2 = (await readiness('E2')).body
    expect(e2.resolution).toMatchObject({ kind: 'DRAW', readyCounts: [0, 0] })
    expect(e2.resolution.winnerTeamId).toBe(e2.teams[1].teamId) // random 0.9 -> segundo equipo
    const e3 = (await readiness('E3')).body
    expect(e3.resolution).toMatchObject({ kind: 'MORE_PLAYERS_READY', readyCounts: [1, 0] })
    expect(e3.resolution.winnerTeamId).toBe(e3.teams[0].teamId)
    expect((await detail('E4')).body.status).not.toBe('FINISHED')
    expect((await readiness('E4')).body.resolution).toBeNull()
    expect((await detail('E5')).body.status).toBe('WAITING_PARTICIPANTS')
  })

  it('el barrido es idempotente y una justa resuelta no se prepara ni se acepta', async () => {
    f.setNow('2026-10-12T00:03:00Z')
    expect(await absences.sweep()).toBe(4)
    expect(await absences.sweep()).toBe(0)
    const prepared = await admin('E1', 'prepare', 'prep-e1')
    expect(prepared.status).toBe(409)
    expect(prepared.body.code).toBe('ENCOUNTER_FINISHED')
    expect(combat.rooms.size).toBe(0)
    const late = await ready('E1', 'p0')
    expect(late.status).toBe(409)
  })

  it('una justa que el administrador ya preparó no se resuelve por ausencia', async () => {
    f.setNow('2026-10-12T00:00:30Z')
    expect((await admin('E2', 'prepare', 'prep-e2')).status).toBe(200)
    f.setNow('2026-10-12T00:03:00Z')
    expect(await absences.sweep()).toBe(3)
    const e2 = (await detail('E2')).body
    expect(e2.status).toBe('READY')
    expect(e2.result ?? null).toBeNull()
  })

  it('las rondas posteriores no tienen horario definido: no abren ventana ni se resuelven', async () => {
    f.setNow('2027-12-31T00:00:00Z')
    await absences.sweep()
    const view = (await readiness('E5')).body
    expect(view.scheduledAt).toBeNull()
    expect((await detail('E5')).body.status).toBe('WAITING_PARTICIPANTS')
  })
})
