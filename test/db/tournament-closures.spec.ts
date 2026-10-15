import { sql } from 'kysely'
import { startTestPostgres } from '../support/postgres'
import { fixture, FREE_POLICY } from '../support/registration-fixture'
import { acceptanceFixture } from '../support/acceptance-fixture'
import {
  createDatabase,
  migrateToLatest,
  MIGRATIONS,
} from '../../src/infrastructure/persistence/database'
import { PostgresRegistrationRepository } from '../../src/adapters/outbound/persistence/PostgresRegistrationRepository'
import { PostgresLifecycleRepository } from '../../src/adapters/outbound/persistence/PostgresLifecycleRepository'
import { PostgresMatchAcceptanceStore } from '../../src/adapters/outbound/persistence/PostgresMatchAcceptanceStore'
import { PostgresTournamentEncounterRepository } from '../../src/adapters/outbound/persistence/PostgresTournamentEncounterRepository'
import { TournamentClosures } from '../../src/application/use-cases/TournamentClosures'

describe('Cierre y actividad sobre PostgreSQL real', () => {
  it('migra torneos publicados, devuelve una vez con dos pools y recupera después de reiniciar', async () => {
    const server = await startTestPostgres(),
      db = createDatabase({ connectionString: server.connectionString })
    const second = createDatabase({ connectionString: server.connectionString })
    try {
      expect(
        (
          await migrateToLatest(
            db,
            Object.fromEntries(Object.entries(MIGRATIONS).filter(([name]) => name < '012')),
          )
        ).error,
      ).toBeUndefined()
      // Adaptador nuevo sobre esquema anterior: crea/lee las columnas históricas sin sobrescribirlas.
      const f = fixture(new PostgresRegistrationRepository(db)),
        t = await f.create()
      for (let n = 0; n < 8; n++) await f.confirm(t.id, n)
      f.setNow('2026-10-10T00:00:00Z')
      await f.brackets.publish(t.id, 'admin', 'publish')
      const before = await f.repo.read(t.id)
      expect((await migrateToLatest(db)).applied).toEqual(['012-tournament-closure'])
      const repo = new PostgresRegistrationRepository(db),
        life = new PostgresLifecycleRepository(db)
      const a = new TournamentClosures(repo, life, f.wallet, f.clock)
      const b = new TournamentClosures(
        new PostgresRegistrationRepository(second),
        new PostgresLifecycleRepository(second),
        f.wallet,
        f.clock,
      )
      f.wallet.uncertainRefund = true
      await Promise.all([a.close(t.id, 'admin', 'close'), b.close(t.id, 'admin', 'close')])
      await b.sweep()
      const after = await repo.read(t.id)
      expect(after.teams).toEqual(before.teams)
      expect(after.bracket).toEqual(before.bracket)
      expect(after.closure?.refunds.every((r) => r.status === 'REFUNDED')).toBe(true)
      expect(f.wallet.refunds).toBe(8)
      await expect(
        sql`UPDATE tournaments SET closure=NULL WHERE id=${t.id}`.execute(db),
      ).rejects.toThrow('IMMUTABLE_TOURNAMENT_CLOSURE')
      const altered = structuredClone(after.closure!)
      altered.refunds[0]!.amount++
      await expect(
        sql`UPDATE tournaments SET closure=${JSON.stringify(altered)}::jsonb WHERE id=${t.id}`.execute(
          db,
        ),
      ).rejects.toThrow('IMMUTABLE_ENTRY_REFUND')
      await expect(
        life.change(t.id, (s) => {
          s.configuration = {} as never
        }),
      ).rejects.toThrow('TOURNAMENT_CLOSED')
    } finally {
      await second.destroy()
      await db.destroy()
      await server.stop()
    }
  })

  it('aceptaciones y ataques reinician el plazo; un torneo futuro y uno reciente permanecen abiertos', async () => {
    const server = await startTestPostgres(),
      db = createDatabase({ connectionString: server.connectionString })
    try {
      expect((await migrateToLatest(db)).error).toBeUndefined()
      const f = await acceptanceFixture({
        mode: 'SOLO',
        registrations: new PostgresRegistrationRepository(db),
        encounters: new PostgresTournamentEncounterRepository(db),
        lifecycle: new PostgresLifecycleRepository(db),
        acceptance: new PostgresMatchAcceptanceStore(db),
      })
      f.setOpen()
      await f.acceptSide()
      const at = (await f.repo.read(f.id)).lastActivityAt!
      expect(at).toBe(f.clock.now().toISOString())
      const attackAt = new Date(new Date(at).getTime() + 25 * 60_000)
      await new PostgresTournamentEncounterRepository(db).appendEvents([
        {
          tournamentId: f.id,
          encounterId: f.e().encounterId,
          seq: 1,
          type: 'basicAttackResolved',
          occurredAt: attackAt,
          payload: {},
        },
      ])
      expect((await f.repo.read(f.id)).lastActivityAt).toBe(attackAt.toISOString())
      const upcoming = fixture(new PostgresRegistrationRepository(db), FREE_POLICY)
      await upcoming.registrations.create('admin', {
        operationId: 'future',
        name: 'Próximo',
        entryFee: 0,
        opensAt: '2026-11-01T00:00:00Z',
        closesAt: '2026-11-02T00:00:00Z',
        startsAt: '2026-11-03T00:00:00Z',
      })
      const close = new TournamentClosures(f.repo, f.lifecycle, f.wallet, f.clock)
      f.setNow(new Date(attackAt.getTime() + 29 * 60_000).toISOString())
      await close.sweep()
      expect((await f.repo.read(f.id)).closure).toBeNull()
      f.setNow(new Date(attackAt.getTime() + 30 * 60_000).toISOString())
      await close.sweep()
      expect((await f.repo.read(f.id)).closure?.reason).toBe('INACTIVITY')
      const future = (await f.repo.list()).find((t) => t.name === 'Próximo')!
      expect(future.closure).toBeNull()
      await expect(f.acceptance.decide(f.id, f.e().encounterId)).rejects.toMatchObject({
        code: 'TOURNAMENT_CLOSED',
      })
    } finally {
      await db.destroy()
      await server.stop()
    }
  })
})
