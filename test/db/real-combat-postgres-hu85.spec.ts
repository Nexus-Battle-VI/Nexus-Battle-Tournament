import type { INestApplication } from '@nestjs/common'
import { ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import type { Kysely } from 'kysely'
import request from 'supertest'

import { AppModule } from '../../src/infrastructure/bootstrap/app.module'
import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
} from '../../src/application/ports/TokenVerifierPort'
import { CLOCK } from '../../src/application/ports/ClockPort'
import { REGISTRATIONS } from '../../src/application/use-cases/Registrations'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { PostgresRegistrationRepository } from '../../src/adapters/outbound/persistence/PostgresRegistrationRepository'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'
import { fixture, FREE_POLICY } from '../support/registration-fixture'
import { startRealCombat, type RealCombat } from '../support/real-combat'
import { startTestPostgres } from '../support/postgres'

/**
 * HU-85.4, recorrido completo en Docker: PostgreSQL REAL (contenedor aislado,
 * con todas las migraciones), Combat REAL (proceso) y el módulo Nest REAL de
 * Tournament configurado solo por variables de entorno (`COMBAT_BASE_URL`,
 * `INTERNAL_SERVICE_AUTH_SECRET`, `DATABASE_URL`) por HTTP.
 * DOBLES: sesiones JWT (verificador controlado), Registrations (Account y
 * Wallet simulados para crear el torneo y el bracket) y Account/Inventory que
 * Combat consulta. Se omite sin `HU85_REAL_COMBAT_DIR`.
 */
const dir = process.env.HU85_REAL_COMBAT_DIR
const suite = dir === undefined ? describe.skip : describe
const SECRET = 'verificacion-hu85-secreto-local'

suite('HU-85 de punta a punta: HTTP + PostgreSQL + Combat real', () => {
  let real: RealCombat
  let postgres: Awaited<ReturnType<typeof startTestPostgres>>
  let db: Kysely<Database>
  let app: INestApplication
  let tid: string
  let previous: Record<string, string | undefined>

  beforeAll(async () => {
    real = await startRealCombat(dir ?? '.', SECRET)
    postgres = await startTestPostgres()
    db = createDatabase({ connectionString: postgres.connectionString })
    const migrated = await migrateToLatest(db)
    if (migrated.error !== undefined) throw new Error('Falló la migración.')
    const values = {
      PERSISTENCE_DRIVER: 'postgres',
      DATABASE_URL: postgres.connectionString,
      AUTH_MODE: 'jwt',
      COGNITO_USER_POOL_ID: 'us-east-1_controlado',
      COGNITO_CLIENT_ID: 'test-client',
      COMBAT_BASE_URL: real.base,
      INTERNAL_SERVICE_AUTH_SECRET: SECRET,
    }
    previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
    Object.assign(process.env, values)
    const f = fixture(new PostgresRegistrationRepository(db), FREE_POLICY)
    tid = (await f.create()).id
    for (let n = 0; n < 8; n += 1) await f.confirm(tid, n)
    await f.brackets.publish(tid, 'admin', 'pub')
    const verifier = {
      verify: (token: string) =>
        /^(?:p\d+|admin|admin2)$/u.test(token)
          ? Promise.resolve({
              subject: token,
              email: null,
              roles: new Set([token.startsWith('admin') ? Role.Administrator : Role.Player]),
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
      .compile()
    app = module.createNestApplication()
    app.setGlobalPrefix('api')
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    )
    await app.init()
  }, 180000)

  afterAll(async () => {
    await app.close()
    await db.destroy()
    await postgres.stop()
    await real.stop()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
  }, 60000)

  const act = (match: string, action: 'prepare' | 'start', operationId: string, token = 'admin') =>
    request(app.getHttpServer())
      .post(`/api/v1/tournaments/admin/${tid}/matches/${tid}:${match}/${action}`)
      .set('Authorization', 'Bearer ' + token)
      .send({ operationId })
  const detail = (match: string) =>
    request(app.getHttpServer())
      .get(`/api/v1/tournaments/${tid}/matches/${tid}:${match}`)
      .set('Authorization', 'Bearer p0')

  it('CA-01/CA-02/CA-04: E1 y E2 simultáneas, inicio repetido con la misma sala, todo persistido', async () => {
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
    expect(s1.body).toMatchObject({ status: 'IN_PROGRESS', battleId: p1.body.battleId })
    expect(s2.body).toMatchObject({ status: 'IN_PROGRESS', battleId: p2.body.battleId })
    const again = await act('E1', 'start', 'start-e1-otro', 'admin2')
    expect(again.body).toMatchObject({
      battleId: p1.body.battleId,
      actionId: s1.body.actionId,
      replayed: true,
    })
    const info = await detail('E1')
    expect(info.body).toMatchObject({ status: 'IN_PROGRESS', combatRoomId: p1.body.battleId })
    expect(info.body.teams).toHaveLength(2)
    const rows = await db
      .selectFrom('tournament_encounter_actions')
      .select(['encounter_id', 'action', 'actor'])
      .where('tournament_id', '=', tid)
      .execute()
    expect(rows).toHaveLength(4)
    expect(new Set(rows.map((r) => r.actor))).toEqual(new Set(['admin', 'admin2']))
  }, 120000)

  it('CA-03: sin participantes, sin permiso o con héroe faltante no se crea sala', async () => {
    const before = real.upstreamCalls.length
    const e5 = await act('E5', 'prepare', 'prep-e5')
    expect(e5.status).toBe(409)
    expect(e5.body.code).toBe('PARTICIPANTS_UNRESOLVED')
    expect((await act('E3', 'prepare', 'x', 'p0')).status).toBe(403)
    expect(real.upstreamCalls.length).toBe(before)
    real.noHero.add('q7')
    const rejected = await act('E4', 'prepare', 'prep-e4')
    expect(rejected.status).toBe(422)
    expect(rejected.body.code).toBe('COMBAT_REJECTED_PARTICIPANTS')
    real.noHero.clear()
    expect((await detail('E4')).body).toMatchObject({ combatRoomId: null })
    expect((await detail('E5')).body.teams).toEqual([])
    expect((await act('E4', 'prepare', 'prep-e4-bis')).status).toBe(200)
  }, 120000)
})
