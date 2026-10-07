import { sql, type Kysely } from 'kysely'
import { mergeArchivedEncounter } from '../../../domain/archive'

import type { CombatEventPage, CombatEventRecord } from '../../../domain/entities/CombatEventRecord'
import type { TournamentEncounter } from '../../../domain/entities/TournamentEncounter'
import type { TournamentEncounterRepositoryPort } from '../../../application/ports/TournamentEncounterRepositoryPort'
import { encounterToRow, eventToRow, rowToEncounter, rowToEvent } from './mapping'
import type { Database } from './schema'

/**
 * Adaptador sobre PostgreSQL. `PERSISTENCE_DRIVER=postgres`: el unico driver
 * admitido en produccion (ADR-022).
 *
 * `appendEvents` es idempotente apoyandose en la restriccion unica
 * `tournament_combat_events_seq_unique` de la migracion
 * `001-tournament-encounters`: un evento con el mismo
 * `(tournament_id, encounter_id, seq)` ya guardado provoca una violacion de
 * unicidad de PostgreSQL (SQLSTATE `23505`), que aqui se interpreta como "ya
 * esta" en lugar de propagarse como fallo. Es el mismo invariante que
 * `InMemoryTournamentEncounterRepository` aplica en memoria con una
 * comprobacion explicita: aqui lo exige el motor, no el adaptador.
 */
export class PostgresTournamentEncounterRepository implements TournamentEncounterRepositoryPort {
  constructor(private readonly db: Kysely<Database>) {}
  async findLinked(): Promise<readonly TournamentEncounter[]> {
    const rows = await this.db
      .selectFrom('tournament_encounters')
      .selectAll()
      .where('combat_room_id', 'is not', null)
      .where((eb) => eb.or([eb('status', '!=', 'FINISHED'), eb('log_complete', '=', false)]))
      .execute()
    return rows.map(rowToEncounter)
  }

  async findAllByTournament(tournamentId: string): Promise<readonly TournamentEncounter[]> {
    const rows = await this.db
      .selectFrom('tournament_encounters')
      .selectAll()
      .where('tournament_id', '=', tournamentId)
      .execute()

    return rows.map(rowToEncounter)
  }

  async findOne(tournamentId: string, encounterId: string): Promise<TournamentEncounter | null> {
    const row = await this.db
      .selectFrom('tournament_encounters')
      .selectAll()
      .where('tournament_id', '=', tournamentId)
      .where('encounter_id', '=', encounterId)
      .executeTakeFirst()

    return row === undefined ? null : rowToEncounter(row)
  }

  async save(encounter: TournamentEncounter): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const lock = JSON.stringify([encounter.tournamentId, encounter.encounterId])
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${lock},0))`.execute(tx)
      const previous = await tx
        .selectFrom('tournament_encounters')
        .selectAll()
        .where('tournament_id', '=', encounter.tournamentId)
        .where('encounter_id', '=', encounter.encounterId)
        .forUpdate()
        .executeTakeFirst()
      const row = encounterToRow(
        mergeArchivedEncounter(previous === undefined ? null : rowToEncounter(previous), encounter),
      )
      await tx
        .insertInto('tournament_encounters')
        .values({ ...row, updated_at: new Date() })
        .onConflict((oc) =>
          oc.columns(['tournament_id', 'encounter_id']).doUpdateSet({
            round: row.round,
            ...(row.bracket_metadata === undefined
              ? {}
              : { bracket_metadata: row.bracket_metadata }),
            bracket_label: row.bracket_label,
            teams: row.teams,
            status: row.status,
            combat_room_id: row.combat_room_id,
            started_at: row.started_at,
            closed_at: row.closed_at,
            result: row.result,
            last_synced_seq: row.last_synced_seq,
            log_complete: row.log_complete,
            updated_at: new Date(),
          }),
        )
        .execute()
    })
  }

  async appendEvents(events: readonly CombatEventRecord[]): Promise<void> {
    if (events.length === 0) {
      return
    }

    await this.db
      .insertInto('tournament_combat_events')
      .values(events.map(eventToRow))
      // Idempotencia a nivel de motor: un `seq` ya guardado para esa justa no
      // se reescribe, se ignora (CA-03).
      .onConflict((oc) => oc.columns(['tournament_id', 'encounter_id', 'seq']).doNothing())
      .execute()
  }

  async listEvents(
    tournamentId: string,
    encounterId: string,
    afterSeq: number,
    limit: number,
  ): Promise<CombatEventPage> {
    const rows = await this.db
      .selectFrom('tournament_combat_events')
      .selectAll()
      .where('tournament_id', '=', tournamentId)
      .where('encounter_id', '=', encounterId)
      .where('seq', '>', afterSeq)
      .orderBy('seq', 'asc')
      .limit(limit + 1)
      .execute()

    const hasMore = rows.length > limit
    const page = rows.slice(0, limit).map(rowToEvent)
    const nextSeq = page.at(-1)?.seq ?? afterSeq

    return { events: page, nextSeq, hasMore }
  }
}
