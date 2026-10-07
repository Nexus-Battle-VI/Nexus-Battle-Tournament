import { sql, type Kysely } from 'kysely'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { startTestPostgres } from '../support/postgres'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'
import { PostgresRegistrationRepository } from '../../src/adapters/outbound/persistence/PostgresRegistrationRepository'
import { PostgresBroadcastRepository } from '../../src/adapters/outbound/persistence/PostgresBroadcastRepository'
import { PostgresTournamentEncounterRepository } from '../../src/adapters/outbound/persistence/PostgresTournamentEncounterRepository'
import * as candidate from '../../src/adapters/outbound/persistence/migrations/009-tournament-broadcast'
import {
  publishedFixture,
  ControlledMatchRead,
  matchFixture,
  storedFixture,
} from '../support/match-read-fixture'
import { Broadcasts } from '../../src/application/use-cases/Broadcasts'
import { ArchivedTournamentMatchReadAdapter } from '../../src/adapters/outbound/combat/ArchivedTournamentMatchReadAdapter'

/** Usa las migraciones compuestas reales; retirar la tabla es un control negativo. */
describe('Observación PostgreSQL: dos procesos, selección durable y fuente HU-83', () => {
  let server: Awaited<ReturnType<typeof startTestPostgres>>, db: Kysely<Database>
  beforeEach(async () => {
    server = await startTestPostgres()
    db = createDatabase({ connectionString: server.connectionString })
    expect((await migrateToLatest(db)).error).toBeUndefined()
  })
  afterEach(async () => {
    await db.destroy()
    await server.stop()
  })
  const setup = async () => {
    const f = await publishedFixture(new PostgresRegistrationRepository(db)),
      source = new ControlledMatchRead(),
      repo = new PostgresBroadcastRepository(db),
      archive = new PostgresTournamentEncounterRepository(db)
    const e1 = matchFixture(f.tournament.bracket!, 'E1', [], null, false, 1),
      e2 = matchFixture(f.tournament.bracket!, 'E2', [], null, false, 1)
    for (const e of [e1, e2]) {
      source.items.set(e.encounterId, e)
      await archive.save(storedFixture(e, f.tournament.bracket!))
      await archive.appendEvents(e.events)
    }
    return {
      ...f,
      source,
      repo,
      archive,
      e1,
      e2,
      service: new Broadcasts(repo, f.registrations.repository, source, f.clock),
    }
  }
  it('sin tabla de emisión devuelve 503 aunque el historial marque su migración', async () => {
    await candidate.down(db as unknown as Kysely<unknown>)
    const repo = new PostgresBroadcastRepository(db)
    await expect(repo.read('fixture')).rejects.toMatchObject({
      status: 503,
      code: 'BROADCAST_PERSISTENCE_UNAVAILABLE',
    })
    await expect(repo.change('fixture', () => null)).rejects.toMatchObject({ status: 503 })
    const registered = await sql<{ name: string }>`select name from kysely_migration`.execute(db)
    expect(registered.rows.some((r) => r.name === '009-tournament-broadcast')).toBe(true)
  })
  it('dos pools designan uno, dos selecciones compiten con revisión y reinicio conserva la ganadora', async () => {
    const f = await setup(),
      second = createDatabase({ connectionString: server.connectionString })
    try {
      const other = new Broadcasts(
        new PostgresBroadcastRepository(second),
        new PostgresRegistrationRepository(second),
        f.source,
        f.clock,
      )
      const assigned = await Promise.allSettled([
        f.service.designate(f.id, 'A'),
        other.designate(f.id, 'B'),
      ])
      expect(assigned.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
      const actor = (await f.service.configuration(f.id)).broadcasterId!
      const selected = await Promise.allSettled([
        f.service.select(f.id, f.e1.encounterId, actor, 1),
        other.select(f.id, f.e2.encounterId, actor, 1),
      ])
      expect(selected.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
      const before = await f.service.configuration(f.id)
      await db.destroy()
      db = createDatabase({ connectionString: server.connectionString })
      const restarted = new Broadcasts(
        new PostgresBroadcastRepository(db),
        new PostgresRegistrationRepository(db),
        f.source,
        f.clock,
      )
      expect(await restarted.configuration(f.id)).toEqual(before)
      expect((await restarted.observe(f.id, actor)).snapshot!.matchId).toBe(before.selectedMatchId)
      expect(await restarted.designate(f.id, actor)).toEqual(before)
      await expect(
        new PostgresBroadcastRepository(db).change('unknown', () => null),
      ).rejects.toMatchObject({ status: 404 })
    } finally {
      await second.destroy()
    }
  })
  it('SQL impide revisión/destino inválidos; final permanece y cambio fallido conserva selección', async () => {
    const f = await setup()
    await f.service.designate(f.id, 'A')
    await f.service.select(f.id, f.e1.encounterId, 'A', 1)
    const before = await f.repo.read(f.id)
    await expect(
      db
        .updateTable('tournament_broadcasts')
        .set({ data: JSON.stringify({ ...before, selectedMatchId: 'E1', revision: 3 }) })
        .where('tournament_id', '=', f.id)
        .execute(),
    ).rejects.toThrow()
    await expect(
      db
        .updateTable('tournament_broadcasts')
        .set({ data: JSON.stringify({ ...before, revision: 99 }) })
        .where('tournament_id', '=', f.id)
        .execute(),
    ).rejects.toThrow()
    const finished = matchFixture(f.tournament.bracket!, 'E1')
    // Completar el archivo conservando el evento inicial ya publicado.
    await f.archive.appendEvents(finished.events.slice(1))
    await f.archive.save(storedFixture(finished, f.tournament.bracket!))
    f.source.items.set(finished.encounterId, finished)
    const offlineCombat = { readRecord: jest.fn().mockRejectedValue(new Error('offline')) }
    const restarted = new Broadcasts(
      new PostgresBroadcastRepository(db),
      new PostgresRegistrationRepository(db),
      new ArchivedTournamentMatchReadAdapter(f.archive, offlineCombat),
      f.clock,
    )
    expect((await restarted.observe(f.id, 'A')).snapshot).toMatchObject({
      status: 'FINISHED',
      seq: 120,
    })
    expect(offlineCombat.readRecord).not.toHaveBeenCalled()
    expect(await f.service.configuration(f.id)).toEqual(before)
    await expect(f.service.select(f.id, 'foreign', 'A', 2)).rejects.toMatchObject({ status: 404 })
    await f.service.select(f.id, f.e2.encounterId, 'A', 2)
    expect((await f.service.configuration(f.id)).selectedMatchId).toBe(f.e2.encounterId)
    await candidate.down(db as unknown as Kysely<unknown>)
    await expect(f.repo.read(f.id)).rejects.toMatchObject({ status: 503 })
  })
})
