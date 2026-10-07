import { sql, type Kysely } from 'kysely'
import type { MatchAcceptanceStore } from '../../../application/ports/MatchAcceptancePorts'
import type { MatchAcceptanceState } from '../../../domain/match-acceptance'
import { requireRule } from '../../../domain/registration'
import type { Database } from './schema'
export class PostgresMatchAcceptanceStore implements MatchAcceptanceStore {
  constructor(private readonly db: Kysely<Database>) {}
  async read(id: string, encounterId: string) {
    const row = await this.db
      .selectFrom('tournament_match_acceptance')
      .select('data')
      .where('tournament_id', '=', id)
      .where('encounter_id', '=', encounterId)
      .executeTakeFirst()
    return row?.data ?? null
  }
  async change<T>(
    initial: MatchAcceptanceState,
    action: (state: MatchAcceptanceState) => T,
  ): Promise<T> {
    return this.db.transaction().execute(async (tx) => {
      const id = initial.tournamentId,
        encounterId = initial.encounterId,
        key = JSON.stringify(['acceptance', id, encounterId])
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`.execute(tx)
      await tx
        .insertInto('tournament_match_acceptance')
        .values({ tournament_id: id, encounter_id: encounterId, data: JSON.stringify(initial) })
        .onConflict((c) => c.columns(['tournament_id', 'encounter_id']).doNothing())
        .execute()
      const row = await tx
        .selectFrom('tournament_match_acceptance')
        .select('data')
        .where('tournament_id', '=', id)
        .where('encounter_id', '=', encounterId)
        .forUpdate()
        .executeTakeFirstOrThrow()
      const state = row.data,
        result = action(state)
      await tx
        .updateTable('tournament_match_acceptance')
        .set({ data: JSON.stringify(state) })
        .where('tournament_id', '=', id)
        .where('encounter_id', '=', encounterId)
        .execute()
      for (const a of state.acceptances) {
        await tx
          .insertInto('tournament_acceptances')
          .values({
            tournament_id: id,
            encounter_id: encounterId,
            subject: a.subject,
            team_id: a.teamId,
            receipt_id: a.receiptId,
            operation_id: a.operationId,
            accepted_at: new Date(a.acceptedAt),
          })
          .onConflict((c) => c.columns(['tournament_id', 'encounter_id', 'subject']).doNothing())
          .execute()
      }
      for (const [operation_id, value] of Object.entries(state.operations)) {
        await tx
          .insertInto('tournament_acceptance_operations')
          .values({
            tournament_id: id,
            encounter_id: encounterId,
            operation_id,
            subject: value.subject,
            receipt_id: value.receiptId,
          })
          .onConflict((c) => c.columns(['tournament_id', 'operation_id']).doNothing())
          .execute()
        const previous = await tx
          .selectFrom('tournament_acceptance_operations')
          .selectAll()
          .where('tournament_id', '=', id)
          .where('operation_id', '=', operation_id)
          .executeTakeFirstOrThrow()
        requireRule(
          previous.encounter_id === encounterId &&
            previous.subject === value.subject &&
            previous.receipt_id === value.receiptId,
          'OPERATION_CONFLICT',
          'La operación corresponde a otra aceptación.',
          409,
        )
      }
      if (state.resolution !== null)
        await tx
          .insertInto('tournament_resolutions')
          .values({
            tournament_id: id,
            encounter_id: encounterId,
            resolution_id: state.resolution.resolutionId,
            data: JSON.stringify(state.resolution),
          })
          .onConflict((c) => c.columns(['tournament_id', 'encounter_id']).doNothing())
          .execute()
      return result
    })
  }
  async resolutions(id: string) {
    const rows = await this.db
      .selectFrom('tournament_resolutions')
      .select('data')
      .where('tournament_id', '=', id)
      .orderBy('encounter_id')
      .execute()
    return rows.map((row) => row.data)
  }
}
