import type { ColumnType, Generated } from 'kysely'
import type {
  EntryPolicy,
  RegistrationTeam,
  RegistrationOperation,
} from '../../../domain/registration'
import type { PublishedBracket } from '../../../domain/bracket'
import type { EncounterBracketMetadata } from '../../../domain/entities/TournamentEncounter'

import type { TournamentEncounterTeam } from '../../../domain/entities/TournamentEncounter'

/**
 * Forma de `result` tal como queda DESPUES de leerlo de la columna `jsonb` y de
 * que `pg` recorra el JSON (`JSON.parse` interno del driver): `finishedAt`
 * sigue siendo texto ISO, no un `Date` — ese paso final de conversion lo hace
 * `mapping.ts`, no el driver.
 */
export interface StoredMatchResult {
  readonly winnerTeamLabel: string | null
  readonly reason: string
  readonly outcome: string
  readonly finishedAt: string
}

/**
 * Esquema de la base de datos del servicio, tipado para Kysely.
 *
 * **Es la unica fuente de verdad de los tipos de persistencia.** No hay paso de
 * generacion de codigo: lo que se declara aqui es lo que el compilador verifica
 * en cada consulta. Cada migracion que cree o cambie una tabla debe reflejarse
 * aqui en el mismo Pull Request.
 *
 * Nombres de columna en `snake_case`, que es la convencion de PostgreSQL. La
 * traduccion a la instantanea del agregado ocurre en un `mapping.ts` explicito.
 */

/**
 * Una justa. Clave primaria compuesta `(tournament_id, encounter_id)`: dos
 * torneos pueden tener una justa "E1" cada uno sin colisionar (CA-01 de
 * HU-83, Management#465: "los registros ... de encuentros simultaneos no se
 * mezclan").
 *
 * `teams` y `result` se guardan como JSON: son la instantanea que Tournament
 * proyecta desde el bracket y desde Combat, no datos que este servicio
 * consulte por su estructura interna en SQL. Normalizarlos en columnas o
 * tablas aparte es prematuro mientras HU-78/HU-85 no fijen su forma definitiva.
 */
export interface TournamentEncounterTable {
  readonly bracket_metadata?: ColumnType<
    EncounterBracketMetadata | null,
    string | null | undefined,
    string | null
  >
  readonly tournament_id: string
  readonly encounter_id: string
  readonly round: number
  readonly bracket_label: string
  // Select: `pg` ya parseo el jsonb a JS. Insert/update: hay que pasar texto
  // JSON explicito, el driver no serializa objetos por su cuenta.
  readonly teams: ColumnType<readonly TournamentEncounterTeam[], string, string>
  readonly status: string
  readonly combat_room_id: string | null
  // Select: `pg` ya parsea `timestamptz` a `Date`. Insert/update aceptan `Date`
  // directamente, sin conversion manual.
  readonly started_at: ColumnType<Date | null, Date | null, Date | null>
  readonly closed_at: ColumnType<Date | null, Date | null, Date | null>
  readonly result: ColumnType<StoredMatchResult | null, string | null, string | null>
  readonly last_synced_seq: number
  readonly log_complete: boolean
  readonly created_at: ColumnType<Date, Date | undefined, never>
  readonly updated_at: ColumnType<Date, Date | undefined, Date>
}

/**
 * Proyeccion de solo-anadir de los eventos de Combat de una justa.
 *
 * La restriccion de unicidad vive en la migracion, sobre
 * `(tournament_id, encounter_id, seq)`: es lo que impide, a nivel de motor,
 * que un reintento reescriba o duplique un evento ya guardado (CA-03).
 */
export interface TournamentCombatEventTable {
  readonly id: Generated<number>
  readonly tournament_id: string
  readonly encounter_id: string
  readonly seq: number
  readonly type: string
  // Select: `pg` ya parseo el jsonb a JS (forma abierta, de ahi `unknown`).
  // Insert: texto JSON explicito. Nunca se actualiza: tabla de solo-anadir.
  readonly payload: ColumnType<unknown, string, never>
  readonly occurred_at: ColumnType<Date, Date, never>
  readonly recorded_at: ColumnType<Date, Date | undefined, never>
}

export interface Database {
  tournaments: RegistrationTournamentTable
  registration_teams: RegistrationTeamTable
  registration_members: { tournament_id: string; team_id: string; player_id: string }
  registration_operations: RegistrationOperationTable
  tournament_admin_operations: { operation_id: string; intent: string; tournament_id: string }
  tournament_encounters: TournamentEncounterTable
  tournament_combat_events: TournamentCombatEventTable
  tournament_encounter_actions: TournamentEncounterActionTable
  tournament_encounter_readiness: TournamentEncounterReadinessTable
  tournament_encounter_absences: TournamentEncounterAbsenceTable
}
export interface TournamentEncounterReadinessTable {
  readonly tournament_id: string
  readonly encounter_id: string
  readonly player_id: string
  readonly accepted_at: ColumnType<Date, Date, never>
}
export interface TournamentEncounterAbsenceTable {
  readonly tournament_id: string
  readonly encounter_id: string
  readonly winner_team_id: string
  readonly kind: 'ONE_TEAM_READY' | 'MORE_PLAYERS_READY' | 'DRAW'
  readonly ready_counts: ColumnType<unknown, string, never>
  readonly resolved_at: ColumnType<Date, Date, never>
}
export interface TournamentEncounterActionTable {
  readonly action_id: string
  readonly tournament_id: string
  readonly encounter_id: string
  readonly action: 'PREPARE' | 'START'
  readonly actor: string
  readonly operation_id: string
  readonly combat_room_id: string
  readonly occurred_at: ColumnType<Date, Date, never>
}
export interface RegistrationTournamentTable {
  id: string
  name: string
  entry_policy: ColumnType<EntryPolicy, string, never>
  entry_fee: ColumnType<string | null, number | null, never>
  opens_at: ColumnType<Date, Date, never>
  closes_at: ColumnType<Date, Date, never>
  starts_at: ColumnType<Date, Date, never>
  starts_epoch: ColumnType<string, number, never>
  bracket: ColumnType<PublishedBracket | null, string | null | undefined, string | null>
}
export interface RegistrationTeamTable {
  id: string
  tournament_id: string
  owner_id: string
  companion_id: string
  status: string
  slot: number | null
  data: ColumnType<RegistrationTeam, string, string>
}
export interface RegistrationOperationTable {
  tournament_id: string
  operation_id: string
  intent: string
  team_id: string
  data: ColumnType<RegistrationOperation, string, string>
}
