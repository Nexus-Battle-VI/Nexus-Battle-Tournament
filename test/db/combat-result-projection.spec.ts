import { startTestPostgres } from '../support/postgres'
import { modeFixture } from '../support/modalities-fixture'
import { matchFixture, storedFixture } from '../support/match-read-fixture'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'
import { PostgresRegistrationRepository } from '../../src/adapters/outbound/persistence/PostgresRegistrationRepository'
import { PostgresTournamentEncounterRepository } from '../../src/adapters/outbound/persistence/PostgresTournamentEncounterRepository'
import { PostgresLifecycleRepository } from '../../src/adapters/outbound/persistence/PostgresLifecycleRepository'
import { ArchivedTournamentMatchReadAdapter } from '../../src/adapters/outbound/combat/ArchivedTournamentMatchReadAdapter'
import { Progressions } from '../../src/application/use-cases/Progressions'
import { FREE_POLICY } from '../support/registration-fixture'

describe('Resultado completo de Combat y proyección reducida en PostgreSQL', () => {
  it.each(
    (['SOLO', 'DUO', 'TRIO'] as const).flatMap((mode) =>
      [false, true].map((isTest) => ({ mode, isTest })),
    ),
  )(
    '$mode (prueba=$isTest): un cierre con marcador y participantes avanza a ganador y perdedor',
    async ({ mode, isTest }) => {
      const server = await startTestPostgres()
      const db = createDatabase({ connectionString: server.connectionString })
      try {
        expect((await migrateToLatest(db)).error).toBeUndefined()
        const archive = new PostgresTournamentEncounterRepository(db)
        const f = await modeFixture(
          mode,
          new PostgresRegistrationRepository(db),
          FREE_POLICY,
          isTest,
        )
        const bracket = await f.publish()
        const match = matchFixture(bracket, 'E1', [], 'A', true, 2)
        match.result!.reason = 'DISCONNECTION'
        const last = match.events.at(-1)!
        const terminal = {
          ...last,
          payload: {
            ...(last.payload as object),
            result: {
              ...match.result,
              tiebreak: null,
              disconnected: { teamLabel: 'B', seat: 0 },
              teams: match.teams.map((t) => ({
                teamLabel: t.teamLabel,
                maxHealth: 100,
                remainingHealth: 100,
                lifePercent: 100,
                eliminated: false,
              })),
              participants: match.teams.flatMap((t) =>
                t.participants.map((p, seat) => ({
                  ...p,
                  seat,
                  kind: 'HUMAN',
                  displayName: p.playerId,
                  teamLabel: t.teamLabel,
                  result: t.teamLabel === 'A' ? 'WON' : 'LOST',
                })),
              ),
            },
          },
        }
        const saved = storedFixture(match, bracket)
        await archive.save({
          ...saved,
          bracketMetadata: {
            ...saved.bracketMetadata!,
            tournamentMode: mode,
            teamSize: f.t.teamSize,
          },
        })
        await archive.appendEvents([...match.events.slice(0, -1), terminal])
        const combat = { readRecord: jest.fn() }
        const progress = new Progressions(
          new PostgresLifecycleRepository(db),
          f.repo,
          new ArchivedTournamentMatchReadAdapter(archive, combat),
          f.clock,
          archive,
        )
        await progress.confirm(f.id, match.encounterId)
        await progress.confirm(f.id, match.encounterId)
        const view = await progress.view(f.id)
        expect(view.bracket!.matches.find((m) => m.id === 'E1')).toMatchObject({
          status: 'FINISHED',
          winnerTeamId: match.teams[0]!.teamId,
          loserTeamId: match.teams[1]!.teamId,
        })
        expect(view.bracket!.matches.find((m) => m.id === 'E5')!.teamIds[0]).toBe(
          match.teams[0]!.teamId,
        )
        expect(view.bracket!.matches.find((m) => m.id === 'E7')!.teamIds[0]).toBe(
          match.teams[1]!.teamId,
        )
        expect(view.statistics.find((s) => s.teamId === match.teams[0]!.teamId)?.victories).toBe(1)
        expect(combat.readRecord).not.toHaveBeenCalled()
      } finally {
        await db.destroy()
        await server.stop()
      }
    },
    30000,
  )
})
