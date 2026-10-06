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
import { fixture } from '../support/registration-fixture'
import { FakeCombat } from '../support/fake-combat'

/**
 * HU-85 (Management#470) por HTTP, con JWT controlado y Combat de prueba.
 * Cada caso lleva el identificador C# del contrato
 * `hu-85-tournament-encounter-administration-v1` y su criterio CA.
 */
describe('HU-85: preparar e iniciar justas independientes', () => {
  let app: INestApplication
  let f: ReturnType<typeof fixture>
  let combat: FakeCombat
  let tid: string
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
    f = fixture()
    combat = new FakeCombat()
    const verifier = {
      verify: (token: string) => {
        if (!/^(?:p\d+|q\d+|admin|admin2|super)$/u.test(token))
          return Promise.reject(new TokenVerificationError())
        return Promise.resolve({
          subject: token,
          email: null,
          roles: new Set([
            token.startsWith('admin')
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
    tid = (await f.create()).id
    for (let n = 0; n < 8; n += 1) await f.confirm(tid, n)
    await f.brackets.publish(tid, 'admin', 'pub')
  })
  afterEach(async () => {
    await app.close()
  })

  const act = (match: string, action: 'prepare' | 'start', operationId: string, token = 'admin') =>
    request(app.getHttpServer())
      .post(`/api/v1/tournaments/admin/${tid}/matches/${tid}:${match}/${action}`)
      .set('Authorization', 'Bearer ' + token)
      .send({ operationId })
  const actions = (token = 'admin') =>
    request(app.getHttpServer())
      .get(`/api/v1/tournaments/admin/${tid}/actions`)
      .set('Authorization', 'Bearer ' + token)
  const detail = (match: string) =>
    request(app.getHttpServer())
      .get(`/api/v1/tournaments/${tid}/matches/${tid}:${match}`)
      .set('Authorization', 'Bearer p0')

  it('C1 CA-01: prepara E1, vincula una sala y deja recibo con actor, justa, acción y fecha', async () => {
    const response = await act('E1', 'prepare', 'prep-e1')
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      tournamentId: tid,
      encounterId: `${tid}:E1`,
      action: 'PREPARE',
      actor: 'admin',
      operationId: 'prep-e1',
      replayed: false,
      status: 'READY',
      preparationStatus: 'PREPARED',
    })
    expect(response.body.battleId).toEqual(expect.any(String))
    expect(Number.isNaN(Date.parse(response.body.occurredAt as string))).toBe(false)
    expect(combat.rooms.size).toBe(1)
    const info = await detail('E1')
    expect(info.body).toMatchObject({ status: 'READY', combatRoomId: response.body.battleId })
    expect(info.body.teams).toHaveLength(2)
    expect((await actions()).body.actions).toHaveLength(1)
  })

  it('C2 CA-01: inicia E1 preparada sobre la misma sala y registra el recibo START', async () => {
    const prepared = await act('E1', 'prepare', 'prep-e1')
    const started = await act('E1', 'start', 'start-e1')
    expect(started.status).toBe(200)
    expect(started.body).toMatchObject({
      action: 'START',
      actor: 'admin',
      battleId: prepared.body.battleId,
      status: 'IN_PROGRESS',
      preparationStatus: 'IN_BATTLE',
      replayed: false,
    })
    expect(combat.startedRooms).toBe(1)
    const info = await detail('E1')
    expect(info.body.status).toBe('IN_PROGRESS')
    expect(info.body.startedAt).toBe('2026-10-12T15:00:00.000Z')
    const receipts = (await actions()).body.actions as { action: string }[]
    expect(receipts.map((r) => r.action)).toEqual(['PREPARE', 'START'])
  })

  it('C3 CA-02: E1 y E2 se preparan e inician simultáneamente, cada una con su sala', async () => {
    const [p1, p2] = await Promise.all([
      act('E1', 'prepare', 'prep-e1'),
      act('E2', 'prepare', 'prep-e2', 'admin2'),
    ])
    expect(p1.status).toBe(200)
    expect(p2.status).toBe(200)
    expect(p1.body.battleId).not.toBe(p2.body.battleId)
    const [s1, s2] = await Promise.all([
      act('E1', 'start', 'start-e1'),
      act('E2', 'start', 'start-e2', 'admin2'),
    ])
    expect(s1.body.preparationStatus).toBe('IN_BATTLE')
    expect(s2.body.preparationStatus).toBe('IN_BATTLE')
    expect(combat.startedRooms).toBe(2)
    const receipts = (await actions()).body.actions as { actor: string }[]
    expect(new Set(receipts.map((r) => r.actor))).toEqual(new Set(['admin', 'admin2']))
  })

  it('C4 CA-03: una semifinal sin participantes se rechaza sin sala, equipos ni ganador', async () => {
    const response = await act('E5', 'prepare', 'prep-e5')
    expect(response.status).toBe(409)
    expect(response.body.code).toBe('PARTICIPANTS_UNRESOLVED')
    expect(combat.createCalls).toBe(0)
    expect(combat.rooms.size).toBe(0)
    const info = await detail('E5')
    expect(info.body).toMatchObject({ status: 'WAITING_PARTICIPANTS', combatRoomId: null })
    expect(info.body.teams).toEqual([])
    expect(info.body.result ?? null).toBeNull()
    expect((await actions()).body.actions).toEqual([])
    expect((await act('E5', 'start', 'start-e5')).body.code).toBe('ENCOUNTER_NOT_PREPARED')
  })

  it('C5 CA-03: una cuenta no administradora recibe 403 y Combat no se toca', async () => {
    expect((await act('E1', 'prepare', 'x', 'p0')).status).toBe(403)
    expect((await act('E1', 'start', 'x', 'p0')).status).toBe(403)
    expect((await actions('p0')).status).toBe(403)
    expect(
      (
        await request(app.getHttpServer())
          .post(`/api/v1/tournaments/admin/${tid}/matches/${tid}:E1/prepare`)
          .send({ operationId: 'x' })
      ).status,
    ).toBe(401)
    expect(combat.createCalls).toBe(0)
    expect((await act('E1', 'prepare', 'ok', 'super')).status).toBe(200)
  })

  it('C6 CA-03: si Combat rechaza a un participante, pasa los bloqueos y no vincula sala', async () => {
    combat.rejected.add('p2')
    const response = await act('E2', 'prepare', 'prep-e2')
    expect(response.status).toBe(422)
    expect(response.body.code).toBe('COMBAT_REJECTED_PARTICIPANTS')
    expect(response.body.blockers).toEqual([{ playerId: 'p2', reason: 'NO_EQUIPPED_HERO' }])
    expect((await detail('E2')).body).toMatchObject({ status: 'WAITING_PARTICIPANTS' })
    expect((await actions()).body.actions).toEqual([])
    combat.rejected.clear()
    expect((await act('E2', 'prepare', 'prep-e2-bis')).status).toBe(200)
  })

  it('C7 CA-04: repetir el mismo inicio devuelve la misma sala y el recibo original', async () => {
    await act('E1', 'prepare', 'prep-e1')
    const first = await act('E1', 'start', 'start-e1')
    const again = await act('E1', 'start', 'start-e1')
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({
      actionId: first.body.actionId,
      battleId: first.body.battleId,
      occurredAt: first.body.occurredAt,
      replayed: true,
    })
    expect(combat.startedRooms).toBe(1)
    expect((await actions()).body.actions).toHaveLength(2)
  })

  it('C8 CA-04: un inicio con otro operationId no crea segundo combate ni segundo recibo', async () => {
    await act('E1', 'prepare', 'prep-e1')
    const first = await act('E1', 'start', 'start-e1')
    const other = await act('E1', 'start', 'start-e1-otro', 'admin2')
    expect(other.body).toMatchObject({
      actionId: first.body.actionId,
      actor: 'admin',
      battleId: first.body.battleId,
      replayed: true,
    })
    expect((await act('E1', 'prepare', 'prep-e1-otro')).body.replayed).toBe(true)
    expect(combat.rooms.size).toBe(1)
    expect(combat.startedRooms).toBe(1)
    expect((await actions()).body.actions).toHaveLength(2)
  })

  it('C9 CA-04: dos inicios concurrentes nombran la misma sala y dejan un solo recibo', async () => {
    await act('E1', 'prepare', 'prep-e1')
    const [a, b] = await Promise.all([
      act('E1', 'start', 'start-a'),
      act('E1', 'start', 'start-b', 'admin2'),
    ])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(a.body.battleId).toBe(b.body.battleId)
    expect(a.body.actionId).toBe(b.body.actionId)
    expect([a.body.replayed, b.body.replayed].sort()).toEqual([false, true])
    expect(combat.startedRooms).toBe(1)
    const receipts = (await actions()).body.actions as { action: string }[]
    expect(receipts.filter((r) => r.action === 'START')).toHaveLength(1)
  })

  it('C9b CA-04: dos preparaciones concurrentes crean una sola sala', async () => {
    const [a, b] = await Promise.all([
      act('E1', 'prepare', 'prep-a'),
      act('E1', 'prepare', 'prep-b', 'admin2'),
    ])
    expect(a.body.battleId).toBe(b.body.battleId)
    expect(combat.rooms.size).toBe(1)
    expect(combat.createCalls).toBe(1)
  })

  it('C10 CA-01/CA-04: Combat caído da 503 sin dejar estado y el reintento llega a la misma sala', async () => {
    combat.down = true
    const failed = await act('E3', 'prepare', 'prep-e3')
    expect(failed.status).toBe(503)
    expect(failed.body.code).toBe('SERVICE_UNAVAILABLE')
    expect((await actions()).body.actions).toEqual([])
    combat.down = false
    const retry = await act('E3', 'prepare', 'prep-e3')
    expect(retry.status).toBe(200)
    expect(combat.rooms.size).toBe(1)
    expect((await act('E3', 'prepare', 'prep-e3')).body.battleId).toBe(retry.body.battleId)
  })

  it('C10b CA-04: respuesta de Combat perdida tras crear la sala; el reintento reutiliza la misma', async () => {
    combat.afterCreate = () => {
      combat.afterCreate = undefined
      combat.down = true
    }
    expect((await act('E4', 'prepare', 'prep-e4')).status).toBe(200)
    combat.down = false
    const roomsBefore = combat.rooms.size
    expect((await act('E4', 'prepare', 'prep-e4-bis')).body.replayed).toBe(true)
    expect(combat.rooms.size).toBe(roomsBefore)
  })

  it('C11 CA-03: reutilizar un operationId en otra justa o acción da OPERATION_CONFLICT', async () => {
    await act('E1', 'prepare', 'misma')
    const otherEncounter = await act('E2', 'prepare', 'misma')
    expect(otherEncounter.status).toBe(409)
    expect(otherEncounter.body.code).toBe('OPERATION_CONFLICT')
    expect((await act('E1', 'start', 'misma')).body.code).toBe('OPERATION_CONFLICT')
    expect(combat.rooms.size).toBe(1)
    expect(combat.startedRooms).toBe(0)
  })

  it('C12 CA-03: iniciar sin preparar da ENCOUNTER_NOT_PREPARED y no llama a Combat', async () => {
    const response = await act('E1', 'start', 'start-e1')
    expect(response.status).toBe(409)
    expect(response.body.code).toBe('ENCOUNTER_NOT_PREPARED')
    expect(combat.startCalls).toBe(0)
  })

  it('valida el formato y las referencias: la autoridad nunca viene del cuerpo', async () => {
    const base = `/api/v1/tournaments/admin/${tid}/matches/${tid}:E1/prepare`
    const send = (body: object) =>
      request(app.getHttpServer()).post(base).set('Authorization', 'Bearer admin').send(body)
    expect((await send({})).status).toBe(400)
    expect((await send({ operationId: '' })).status).toBe(400)
    expect((await send({ operationId: 'x', actor: 'otro' })).status).toBe(400)
    expect((await send({ operationId: 'x', teams: [] })).status).toBe(400)
    expect((await act('E99', 'prepare', 'x')).body.code).toBe('ENCOUNTER_NOT_FOUND')
    const missing = await request(app.getHttpServer())
      .post('/api/v1/tournaments/admin/no-existe/matches/no-existe:E1/prepare')
      .set('Authorization', 'Bearer admin')
      .send({ operationId: 'x' })
    expect(missing.status).toBe(404)
    expect(missing.body.code).toBe('TOURNAMENT_NOT_FOUND')
    expect(combat.createCalls).toBe(0)
  })
})
