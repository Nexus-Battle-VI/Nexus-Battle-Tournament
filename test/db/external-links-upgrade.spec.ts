import { startTestPostgres } from '../support/postgres'
import { sql } from 'kysely'
import {
  createDatabase,
  migrateToLatest,
  MIGRATIONS,
} from '../../src/infrastructure/persistence/database'
import { PostgresRegistrationRepository } from '../../src/adapters/outbound/persistence/PostgresRegistrationRepository'
import { PostgresTournamentEncounterRepository } from '../../src/adapters/outbound/persistence/PostgresTournamentEncounterRepository'
import { PostgresExternalLinksRepository } from '../../src/adapters/outbound/persistence/PostgresExternalLinksRepository'
import { ExternalLinks } from '../../src/application/use-cases/ExternalLinks'
import { fixture, FREE_POLICY } from '../support/registration-fixture'

it('upgrade desde HU-83 conserva archivo existente y registro/bracket al añadir HU-82', async () => {
  const server = await startTestPostgres()
  const db = createDatabase({ connectionString: server.connectionString })
  try {
    const legacy = { '001-tournament-encounters': MIGRATIONS['001-tournament-encounters']! }
    expect((await migrateToLatest(db, legacy)).error).toBeUndefined()
    const archive = new PostgresTournamentEncounterRepository(db)
    const existing = {
      tournamentId: 'legacy',
      encounterId: 'opaque-existing-id',
      round: 1,
      bracketLabel: 'E1',
      teams: [],
      status: 'FINISHED' as const,
      combatRoomId: 'historic-room',
      startedAt: new Date('2026-09-01T12:00:00Z'),
      closedAt: new Date('2026-09-01T12:10:00Z'),
      result: {
        outcome: 'NO_WINNER',
        winnerTeamLabel: null,
        reason: 'DOUBLE_ABANDON',
        finishedAt: new Date('2026-09-01T12:10:00Z'),
      },
      lastSyncedSeq: 1,
      logComplete: true,
    }
    await archive.save(existing)
    await archive.appendEvents([
      {
        tournamentId: 'legacy',
        encounterId: existing.encounterId,
        seq: 1,
        type: 'battleFinished',
        occurredAt: existing.closedAt,
        payload: { roomId: 'historic-room', result: { outcome: 'NO_WINNER' } },
      },
    ])
    const beforeEvents = await archive.listEvents('legacy', existing.encounterId, 0, 100)
    const registrationBase = Object.fromEntries(
      Object.entries(MIGRATIONS).filter(([name]) => name < '008'),
    )
    expect((await migrateToLatest(db, registrationBase)).error).toBeUndefined()
    const legacyRegistration = new PostgresRegistrationRepository(db)
    // Sembrar con las columnas de 007: el adaptador actual exige is_test (011).
    // Esta prueba verifica datos anteriores al upgrade, no ejecutar código nuevo
    // contra una base que todavía no recibió sus migraciones.
    legacyRegistration.create = async (t, operationId, intent) => {
      await db.transaction().execute(async (tx) => {
        await sql`
          INSERT INTO tournaments
            (id, name, entry_fee, entry_policy, opens_at, closes_at, starts_at,
             starts_epoch, tournament_mode, team_size, contract_version,
             acceptance_policy, round_windows)
          VALUES (${t.id}, ${t.name}, ${t.entryFee}, ${JSON.stringify(t.entryPolicy)}::jsonb,
                  ${new Date(t.opensAt)}, ${new Date(t.closesAt)}, ${new Date(t.startsAt)},
                  ${new Date(t.startsAt).getTime()}, ${t.tournamentMode ?? 'DUO'},
                  ${t.teamSize ?? 2}, ${t.contractVersion ?? 'torneos-hu77-84-78-hu83-v2.0.0'},
                  ${t.acceptancePolicy ?? null}, ${JSON.stringify(t.roundWindows ?? [])}::jsonb)
        `.execute(tx)
        await tx
          .insertInto('tournament_admin_operations')
          .values({ operation_id: operationId, intent, tournament_id: t.id })
          .execute()
      })
      return t
    }
    const f = fixture(legacyRegistration, FREE_POLICY)
    const tournament = await f.create()
    for (let n = 0; n < 8; n++) await f.confirm(tournament.id, n)
    f.setNow('2026-10-10T00:00:00Z')
    await f.brackets.publish(tournament.id, 'admin', 'publish')
    const before = await f.repo.read(tournament.id)
    expect((await migrateToLatest(db)).applied).toEqual([
      '008-tournament-external-links',
      '009-tournament-broadcast',
      '010-tournament-combat-result-projection',
      '011-test-tournaments',
    ])
    const links = new ExternalLinks(new PostgresExternalLinksRepository(db), f.repo, f.clock)
    await links.save(tournament.id, {
      liveUrl: 'https://twitch.tv/fixture_channel',
      youtubeArchiveUrl: 'https://youtube.com/@FixtureChannel/videos',
      expectedRevision: 0,
    })
    expect(await archive.findOne('legacy', existing.encounterId)).toEqual(existing)
    expect(await archive.listEvents('legacy', existing.encounterId, 0, 100)).toEqual(beforeEvents)
    expect(before.isTest).toBeUndefined()
    expect(await f.repo.read(tournament.id)).toEqual({ ...before, isTest: false })
    expect((await links.view(tournament.id)).revision).toBe(1)
  } finally {
    await db.destroy()
    await server.stop()
  }
})
