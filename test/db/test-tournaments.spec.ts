import { sql } from 'kysely'
import { startTestPostgres } from '../support/postgres'
import { fixture, FREE_POLICY } from '../support/registration-fixture'
import { PostgresRegistrationRepository } from '../../src/adapters/outbound/persistence/PostgresRegistrationRepository'
import {
  createDatabase,
  migrateToLatest,
  MIGRATIONS,
} from '../../src/infrastructure/persistence/database'

describe('Calendario oficial y pruebas sobre PostgreSQL real', () => {
  it('migra sin convertir el torneo anterior y protege calendario, tipo y premios directamente en SQL', async () => {
    const server = await startTestPostgres()
    const db = createDatabase({ connectionString: server.connectionString })
    try {
      const previous = Object.fromEntries(
        Object.entries(MIGRATIONS).filter(([name]) => name !== '011-test-tournaments'),
      )
      expect((await migrateToLatest(db, previous)).error).toBeUndefined()
      await sql`INSERT INTO tournaments(id,name,entry_policy,entry_fee,opens_at,closes_at,starts_at,starts_epoch)
        VALUES('existing-official','Torneo anterior','{"version":1,"free":true,"methods":[]}',0,
          '2026-10-01T00:00:00Z','2026-10-10T00:00:00Z','2026-10-12T00:00:00Z',1791763200000)`.execute(
        db,
      )
      expect((await migrateToLatest(db)).error).toBeUndefined()
      const repo = new PostgresRegistrationRepository(db)
      expect(await repo.read('existing-official')).toMatchObject({
        name: 'Torneo anterior',
        isTest: false,
      })
      const f = fixture(repo, FREE_POLICY)
      await expect(f.create('SOLO')).rejects.toMatchObject({ code: 'CALENDAR_CONFLICT' })
      const pilot = await f.registrations.create('admin', {
        operationId: 'pilot',
        name: 'Prueba',
        isTest: true,
        tournamentMode: 'SOLO',
        entryPolicy: FREE_POLICY,
        opensAt: '2026-10-01T00:00:00Z',
        closesAt: '2026-10-10T00:00:00Z',
        startsAt: '2026-10-12T00:00:00Z',
      })
      expect((await repo.read(pilot.id)).isTest).toBe(true)
      await expect(
        sql`UPDATE tournaments SET is_test=true WHERE id='existing-official'`.execute(db),
      ).rejects.toThrow('IMMUTABLE_TOURNAMENT_CONFIGURATION')
      await expect(
        sql`UPDATE tournaments SET entry_policy='{"version":1,"free":false,"methods":[{"method":"CREDITS","amount":10}]}'
        WHERE id=${pilot.id}`.execute(db),
      ).rejects.toThrow()
      await expect(
        sql`INSERT INTO tournaments(id,name,entry_policy,entry_fee,opens_at,closes_at,starts_at,starts_epoch)
        VALUES('illegal-official','Otra oficial','{"version":1,"free":true,"methods":[]}',0,
          '2026-10-01T00:00:00Z','2026-10-10T00:00:00Z','2026-10-13T00:00:00Z',1791849600000)`.execute(
          db,
        ),
      ).rejects.toThrow('tournaments_calendar')
      await expect(
        sql`INSERT INTO tournament_lifecycle(tournament_id,data)
        VALUES(${pilot.id}, ${JSON.stringify({ tournamentId: pilot.id, results: [], champion: null, configuration: {}, delivery: null })}::jsonb)`.execute(
          db,
        ),
      ).rejects.toThrow('TEST_TOURNAMENT_NO_PRIZES')
      expect((await migrateToLatest(db)).applied).toEqual([])
    } finally {
      await db.destroy()
      await server.stop()
    }
  })
})
