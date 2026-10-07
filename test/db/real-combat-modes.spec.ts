import type { INestApplication } from '@nestjs/common'
import { ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import type { Kysely } from 'kysely'
import request from 'supertest'
import { startRealCombat, type RealCombat } from '../support/real-combat'
import { startTestPostgres } from '../support/postgres'
import { modeFixture } from '../support/modalities-fixture'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'
import { PostgresRegistrationRepository } from '../../src/adapters/outbound/persistence/PostgresRegistrationRepository'
import { AppModule } from '../../src/infrastructure/bootstrap/app.module'
import { REGISTRATIONS } from '../../src/application/use-cases/Registrations'
import {
  ACCEPTANCE_RECONCILIATION,
  type AcceptanceReconciliation,
} from '../../src/application/use-cases/AcceptanceReconciliation'
import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
} from '../../src/application/ports/TokenVerifierPort'
import { CLOCK } from '../../src/application/ports/ClockPort'
import { HttpCombatRecordAdapter } from '../../src/adapters/outbound/combat/HttpCombatRecordAdapter'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import type { TournamentMode } from '../../src/domain/registration'

const dir = process.env.HU85_REAL_COMBAT_DIR
const suite = dir === undefined ? describe.skip : describe
const SECRET = 'verificacion-hu85-secreto-local'
/** Motor/HTTP/HMAC reales y PostgreSQL real. Account, Inventory y verificador JWT son dobles controlados. */
suite('Modalidades v3 con Tournament HTTP + PostgreSQL + Combat real', () => {
  let real: RealCombat
  beforeAll(async () => {
    real = await startRealCombat(dir ?? '.', SECRET)
  }, 90000)
  afterAll(async () => {
    await real.stop()
  })
  it.each(['SOLO', 'DUO', 'TRIO'] as TournamentMode[])(
    '%s: aceptación individual, E1/E2 simultáneas y reintentos a la misma sala',
    async (mode) => {
      const server = await startTestPostgres(),
        db: Kysely<Database> = createDatabase({ connectionString: server.connectionString })
      let app: INestApplication | undefined
      const values = {
        PERSISTENCE_DRIVER: 'postgres',
        DATABASE_URL: server.connectionString,
        AUTH_MODE: 'jwt',
        COGNITO_USER_POOL_ID: 'us-east-1_controlado',
        COGNITO_CLIENT_ID: 'test-client',
        COMBAT_BASE_URL: real.base,
        INTERNAL_SERVICE_AUTH_SECRET: SECRET,
      }
      const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
      Object.assign(process.env, values)
      try {
        expect((await migrateToLatest(db)).error).toBeUndefined()
        const f = await modeFixture(mode, new PostgresRegistrationRepository(db)),
          b = await f.publish()
        const members = new Set(b.seeds.flatMap((s) => s.memberIds))
        const module = await Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(CLOCK)
          .useValue(f.clock)
          .overrideProvider(REGISTRATIONS)
          .useValue(f.registrations)
          .overrideProvider(TOKEN_VERIFIER)
          .useValue({
            verify: (token: string) =>
              members.has(token) || token === 'admin'
                ? Promise.resolve({
                    subject: token,
                    email: null,
                    roles: new Set([token === 'admin' ? Role.Administrator : Role.Player]),
                  })
                : Promise.reject(new TokenVerificationError()),
          })
          .compile()
        app = module.createNestApplication()
        app.setGlobalPrefix('api')
        app.useGlobalPipes(
          new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
        )
        await app.init()
        const worker = app.get<AcceptanceReconciliation>(ACCEPTANCE_RECONCILIATION)
        const first = b.matches.filter((m) => ['E1', 'E2'].includes(m.id))
        const matchUrl = (e: string) =>
          `/api/v1/tournaments/${f.id}/matches/${encodeURIComponent(e)}`
        const action = (e: string, action: 'prepare' | 'start', operationId: string) =>
          request(app!.getHttpServer())
            .post(`/api/v1/tournaments/admin/${f.id}/matches/${encodeURIComponent(e)}/${action}`)
            .set('Authorization', 'Bearer admin')
            .send({ operationId })
        f.setNow(f.t.roundSchedule[0]!.acceptanceOpensAt)
        for (const m of first) {
          const ids = m.teamIds.flatMap(
            (teamId) => b.seeds.find((s) => s.teamId === teamId)!.memberIds,
          )
          const accepted = await Promise.all(
            ids.map((subject) =>
              request(app!.getHttpServer())
                .post(matchUrl(m.encounterId) + '/acceptance')
                .set('Authorization', 'Bearer ' + subject)
                .send({ operationId: 'accept-' + m.encounterId + subject }),
            ),
          )
          expect(accepted.every((r) => r.status === 200)).toBe(true)
        }
        expect((await action(first[0]!.encounterId, 'prepare', 'too-early')).status).toBe(409)
        const opens = new Date(f.t.roundSchedule[0]!.acceptanceOpensAt).getTime()
        for (let step = 5; step < 120; step += 5) {
          f.setNow(new Date(opens + step * 1000).toISOString())
          await worker.sweep()
        }
        f.setNow(f.t.roundSchedule[0]!.acceptanceClosesAt)
        await Promise.all(first.map((m) => worker.run(f.id, m.encounterId)))
        const states = await db
          .selectFrom('tournament_match_acceptance')
          .select('data')
          .where('tournament_id', '=', f.id)
          .execute()
        const rooms: string[] = []
        const reader = new HttpCombatRecordAdapter(real.base, SECRET)
        for (const m of first) {
          const state = states.find((s) => s.data.encounterId === m.encounterId)!.data
          expect(state.blocker).toBeNull()
          expect(state.combatIntent!.phase).toBe('STARTED')
          const roomId = state.combatIntent!.roomId!
          rooms.push(roomId)
          const record = await reader.readRecord(roomId, 0)
          expect(record.status).toBe('IN_BATTLE')
          expect(record.startedAt).toBeInstanceOf(Date)
          const expected = m.teamIds.flatMap(
            (teamId) => b.seeds.find((s) => s.teamId === teamId)!.memberIds,
          )
          expect(
            record.teams!.flatMap((t) => t.participants.map((p) => p.playerId)).sort(),
          ).toEqual(expected.sort())
          expect(record.teams!.flatMap((t) => t.participants)).toHaveLength(2 * f.t.teamSize)
          const retries = await Promise.all([
            action(m.encounterId, 'prepare', 'admin-recovery-' + m.encounterId),
            action(m.encounterId, 'start', 'admin-recovery-start-' + m.encounterId),
          ])
          expect(
            retries.every(
              (r) => r.status === 200 && (r.body as { battleId: string }).battleId === roomId,
            ),
          ).toBe(true)
          const detail = await request(app.getHttpServer())
            .get(matchUrl(m.encounterId))
            .set('Authorization', 'Bearer ' + b.seeds[0]!.memberIds[0]!)
          expect(detail.body).toMatchObject({
            status: 'IN_PROGRESS',
            startedAt: record.startedAt!.toISOString(),
            scheduledStartAt: f.t.roundSchedule[0]!.scheduledStartAt,
            resolution: null,
          })
        }
        const designated = await request(app.getHttpServer())
          .post('/api/v1/tournaments/admin/' + f.id + '/broadcast/designate')
          .set('Authorization', 'Bearer admin')
          .send({})
        expect(designated.status).toBe(200)
        let revision = 1
        for (const m of first) {
          const selected = await request(app.getHttpServer())
            .post('/api/v1/tournaments/' + f.id + '/broadcast/selection')
            .set('Authorization', 'Bearer admin')
            .send({ matchId: m.encounterId, expectedRevision: revision })
          expect(selected.status).toBe(200)
          const view = selected.body as {
            state: { revision: number }
            snapshot: { combatants: unknown[]; encounterId: string }
          }
          revision = view.state.revision
          expect(view.snapshot.encounterId).toBe(m.encounterId)
          expect(view.snapshot.combatants).toHaveLength(f.t.teamSize * 2)
          expect(JSON.stringify(view.snapshot)).not.toMatch(/internalSeed|commandId|token/u)
        }
        expect(new Set(rooms).size).toBe(2)
        expect(
          (
            await db
              .selectFrom('tournament_encounter_actions')
              .selectAll()
              .where('tournament_id', '=', f.id)
              .execute()
          ).filter((a) => first.some((m) => m.encounterId === a.encounter_id)),
        ).toHaveLength(4)
        expect(
          await db
            .selectFrom('tournament_resolutions')
            .selectAll()
            .where(
              'encounter_id',
              'in',
              first.map((m) => m.encounterId),
            )
            .execute(),
        ).toEqual([])
      } finally {
        await app?.close()
        await db.destroy()
        await server.stop()
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) Reflect.deleteProperty(process.env, key)
          else process.env[key] = value
        }
      }
    },
    90000,
  )
})
