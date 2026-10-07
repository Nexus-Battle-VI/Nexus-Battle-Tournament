import type { Kysely } from 'kysely'

import type { AbsenceResolution, ReadinessRecord } from '../../../domain/absence'
import type { AbsenceStore } from '../../../application/ports/AbsencePorts'
import type { Database } from './schema'

const counts = (value: unknown): readonly [number, number] => {
  const list = typeof value === 'string' ? (JSON.parse(value) as unknown) : value
  return Array.isArray(list) && list.length === 2 ? [Number(list[0]), Number(list[1])] : [0, 0]
}

export class PostgresAbsenceStore implements AbsenceStore {
  constructor(private readonly db: Kysely<Database>) {}

  async accept(record: ReadinessRecord): Promise<void> {
    await this.db
      .insertInto('tournament_encounter_readiness')
      .values({
        tournament_id: record.tournamentId,
        encounter_id: record.encounterId,
        player_id: record.playerId,
        accepted_at: record.acceptedAt,
      })
      .onConflict((conflict) => conflict.doNothing())
      .execute()
  }

  async listReady(tournamentId: string, encounterId: string) {
    const rows = await this.db
      .selectFrom('tournament_encounter_readiness')
      .selectAll()
      .where('tournament_id', '=', tournamentId)
      .where('encounter_id', '=', encounterId)
      .orderBy('accepted_at', 'asc')
      .execute()
    return rows.map((row) => ({
      tournamentId: row.tournament_id,
      encounterId: row.encounter_id,
      playerId: row.player_id,
      acceptedAt: row.accepted_at,
    }))
  }

  async findResolution(tournamentId: string, encounterId: string) {
    const row = await this.db
      .selectFrom('tournament_encounter_absences')
      .selectAll()
      .where('tournament_id', '=', tournamentId)
      .where('encounter_id', '=', encounterId)
      .executeTakeFirst()
    return row === undefined
      ? null
      : {
          tournamentId: row.tournament_id,
          encounterId: row.encounter_id,
          winnerTeamId: row.winner_team_id,
          kind: row.kind,
          readyCounts: counts(row.ready_counts),
          resolvedAt: row.resolved_at,
        }
  }

  async saveResolution(resolution: AbsenceResolution): Promise<AbsenceResolution> {
    await this.db
      .insertInto('tournament_encounter_absences')
      .values({
        tournament_id: resolution.tournamentId,
        encounter_id: resolution.encounterId,
        winner_team_id: resolution.winnerTeamId,
        kind: resolution.kind,
        ready_counts: JSON.stringify(resolution.readyCounts),
        resolved_at: resolution.resolvedAt,
      })
      .onConflict((conflict) => conflict.doNothing())
      .execute()
    const saved = await this.findResolution(resolution.tournamentId, resolution.encounterId)
    return saved ?? resolution
  }
}
