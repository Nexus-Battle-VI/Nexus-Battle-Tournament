import {
  encounterToRow,
  eventToRow,
  rowToEncounter,
  rowToEvent,
} from '../../src/adapters/outbound/persistence/mapping'
import {
  TournamentMatchStatus,
  type TournamentEncounter,
} from '../../src/domain/entities/TournamentEncounter'
import type { CombatEventRecord } from '../../src/domain/entities/CombatEventRecord'
import type { Selectable } from 'kysely'
import type {
  TournamentCombatEventTable,
  TournamentEncounterTable,
} from '../../src/adapters/outbound/persistence/schema'

describe('mapping de persistencia', () => {
  it('encounterToRow -> rowToEncounter conserva una justa finalizada con resultado', () => {
    const encounter: TournamentEncounter = {
      tournamentId: 'T1',
      encounterId: 'E3',
      round: 1,
      bracketLabel: 'E3',
      teams: [
        { teamId: 'a', teamLabel: 'A', participants: [{ playerId: 'p1', heroId: 'h1' }] },
        { teamId: 'b', teamLabel: 'B', participants: [{ playerId: 'p2', heroId: 'h2' }] },
      ],
      status: TournamentMatchStatus.Finished,
      combatRoomId: 'room-T1-E3',
      startedAt: new Date('2026-09-30T19:00:00.000Z'),
      closedAt: new Date('2026-09-30T19:18:00.000Z'),
      result: {
        winnerTeamLabel: 'A',
        reason: 'OPPONENT_DEFEATED',
        outcome: 'VICTORY',
        finishedAt: new Date('2026-09-30T19:18:00.000Z'),
      },
      lastSyncedSeq: 5,
      logComplete: true,
    }

    const inserted = encounterToRow(encounter)

    // Simula lo que devuelve `pg`: jsonb ya parseado a objeto, timestamptz ya
    // parseado a `Date`. Las columnas en texto (`teams`, `result`) se
    // "re-parsean" aqui para construir la fila tal como la devolveria el motor.
    const row: Selectable<TournamentEncounterTable> = {
      ...inserted,
      combat_room_id: inserted.combat_room_id ?? null,
      started_at: inserted.started_at ?? null,
      closed_at: inserted.closed_at ?? null,
      teams: JSON.parse(inserted.teams) as TournamentEncounter['teams'],
      result:
        inserted.result === null || inserted.result === undefined
          ? null
          : JSON.parse(inserted.result),
      created_at: new Date('2026-09-30T18:00:00.000Z'),
      updated_at: new Date('2026-09-30T19:18:00.000Z'),
    }

    expect(rowToEncounter(row)).toEqual(encounter)
  })

  it('encounterToRow -> rowToEncounter conserva una justa esperando participantes', () => {
    const encounter: TournamentEncounter = {
      tournamentId: 'T1',
      encounterId: 'E4',
      round: 2,
      bracketLabel: 'E4',
      teams: [],
      status: TournamentMatchStatus.WaitingParticipants,
      combatRoomId: null,
      startedAt: null,
      closedAt: null,
      result: null,
      lastSyncedSeq: 0,
      logComplete: false,
    }

    const inserted = encounterToRow(encounter)
    const row: Selectable<TournamentEncounterTable> = {
      ...inserted,
      combat_room_id: inserted.combat_room_id ?? null,
      started_at: inserted.started_at ?? null,
      closed_at: inserted.closed_at ?? null,
      teams: JSON.parse(inserted.teams) as TournamentEncounter['teams'],
      result: null,
      created_at: new Date('2026-09-30T18:00:00.000Z'),
      updated_at: new Date('2026-09-30T18:00:00.000Z'),
    }

    expect(rowToEncounter(row)).toEqual(encounter)
  })

  it('eventToRow -> rowToEvent conserva un evento de Combat', () => {
    const event: CombatEventRecord = {
      tournamentId: 'T1',
      encounterId: 'E2',
      seq: 3,
      type: 'turnResolved',
      payload: { damage: 42 },
      occurredAt: new Date('2026-09-30T20:02:00.000Z'),
    }

    const inserted = eventToRow(event)
    const row: Selectable<TournamentCombatEventTable> = {
      ...inserted,
      id: 1,
      payload: JSON.parse(inserted.payload) as unknown,
      recorded_at: new Date('2026-09-30T20:02:05.000Z'),
    }

    expect(rowToEvent(row)).toEqual(event)
  })
})
