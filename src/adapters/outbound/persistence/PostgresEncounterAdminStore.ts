import type { Kysely, Selectable } from 'kysely'

import type {
  EncounterAdminAction,
  EncounterAdminActionRecord,
} from '../../../domain/encounter-admin'
import { RegistrationError } from '../../../domain/registration'
import type { EncounterAdminStore } from '../../../application/ports/EncounterAdminPorts'
import type { Database, TournamentEncounterActionTable } from './schema'

const toRecord = (row: Selectable<TournamentEncounterActionTable>): EncounterAdminActionRecord => ({
  actionId: row.action_id,
  tournamentId: row.tournament_id,
  encounterId: row.encounter_id,
  action: row.action,
  actor: row.actor,
  operationId: row.operation_id,
  combatRoomId: row.combat_room_id,
  occurredAt: row.occurred_at,
})

/**
 * Recibos en PostgreSQL. La unicidad `(torneo, justa, accion)` y
 * `(torneo, operacion)` la imponen las restricciones de la tabla: dos
 * solicitudes concurrentes no pueden dejar dos recibos aunque corran en
 * instancias distintas del servicio.
 */
export class PostgresEncounterAdminStore implements EncounterAdminStore {
  constructor(private readonly db: Kysely<Database>) {}

  async findByOperation(tournamentId: string, operationId: string) {
    const row = await this.db
      .selectFrom('tournament_encounter_actions')
      .selectAll()
      .where('tournament_id', '=', tournamentId)
      .where('operation_id', '=', operationId)
      .executeTakeFirst()
    return row === undefined ? null : toRecord(row)
  }

  async findByAction(tournamentId: string, encounterId: string, action: EncounterAdminAction) {
    const row = await this.db
      .selectFrom('tournament_encounter_actions')
      .selectAll()
      .where('tournament_id', '=', tournamentId)
      .where('encounter_id', '=', encounterId)
      .where('action', '=', action)
      .executeTakeFirst()
    return row === undefined ? null : toRecord(row)
  }

  async insert(record: EncounterAdminActionRecord): Promise<EncounterAdminActionRecord> {
    await this.db
      .insertInto('tournament_encounter_actions')
      .values({
        action_id: record.actionId,
        tournament_id: record.tournamentId,
        encounter_id: record.encounterId,
        action: record.action,
        actor: record.actor,
        operation_id: record.operationId,
        combat_room_id: record.combatRoomId,
        occurred_at: record.occurredAt,
      })
      .onConflict((conflict) => conflict.doNothing())
      .execute()
    const existing = await this.findByAction(record.tournamentId, record.encounterId, record.action)
    if (existing === null)
      throw new RegistrationError(
        'OPERATION_CONFLICT',
        'El identificador corresponde a otra intención.',
        409,
      )
    return existing
  }

  async list(tournamentId: string) {
    const rows = await this.db
      .selectFrom('tournament_encounter_actions')
      .selectAll()
      .where('tournament_id', '=', tournamentId)
      .orderBy('occurred_at', 'asc')
      .orderBy('encounter_id', 'asc')
      .orderBy('action', 'asc')
      .execute()
    return rows.map(toRecord)
  }
}
