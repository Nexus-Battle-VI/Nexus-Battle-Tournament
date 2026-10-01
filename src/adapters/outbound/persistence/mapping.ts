import type { Insertable, Selectable } from 'kysely'

import type { CombatEventRecord } from '../../../domain/entities/CombatEventRecord'
import type {
  TournamentEncounter,
  TournamentMatchStatus,
} from '../../../domain/entities/TournamentEncounter'
import type { TournamentCombatEventTable, TournamentEncounterTable } from './schema'

/**
 * Traduccion explicita entre la instantanea del agregado (dominio) y las filas
 * de PostgreSQL (`snake_case`, JSON serializado a texto en lo que se escribe).
 * Vive aparte del repositorio para que el repositorio en si solo orqueste
 * consultas.
 */

export const encounterToRow = (
  encounter: TournamentEncounter,
): Omit<Insertable<TournamentEncounterTable>, 'created_at' | 'updated_at'> => ({
  tournament_id: encounter.tournamentId,
  encounter_id: encounter.encounterId,
  round: encounter.round,
  bracket_label: encounter.bracketLabel,
  teams: JSON.stringify(encounter.teams),
  status: encounter.status,
  combat_room_id: encounter.combatRoomId,
  started_at: encounter.startedAt,
  closed_at: encounter.closedAt,
  result: encounter.result === null ? null : JSON.stringify(encounter.result),
  last_synced_seq: encounter.lastSyncedSeq,
  log_complete: encounter.logComplete,
})

export const rowToEncounter = (row: Selectable<TournamentEncounterTable>): TournamentEncounter => ({
  tournamentId: row.tournament_id,
  encounterId: row.encounter_id,
  round: row.round,
  bracketLabel: row.bracket_label,
  teams: row.teams,
  status: row.status as TournamentMatchStatus,
  combatRoomId: row.combat_room_id,
  startedAt: row.started_at,
  closedAt: row.closed_at,
  result:
    row.result === null
      ? null
      : {
          winnerTeamLabel: row.result.winnerTeamLabel,
          reason: row.result.reason,
          outcome: row.result.outcome,
          finishedAt: new Date(row.result.finishedAt),
        },
  lastSyncedSeq: row.last_synced_seq,
  logComplete: row.log_complete,
})

export const eventToRow = (
  event: CombatEventRecord,
): Omit<Insertable<TournamentCombatEventTable>, 'id' | 'recorded_at'> => ({
  tournament_id: event.tournamentId,
  encounter_id: event.encounterId,
  seq: event.seq,
  type: event.type,
  payload: JSON.stringify(event.payload),
  occurred_at: event.occurredAt,
})

export const rowToEvent = (row: Selectable<TournamentCombatEventTable>): CombatEventRecord => ({
  tournamentId: row.tournament_id,
  encounterId: row.encounter_id,
  seq: row.seq,
  type: row.type,
  payload: row.payload,
  occurredAt: row.occurred_at,
})
