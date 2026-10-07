import { sql, type Kysely, type Transaction } from 'kysely'
import { sameJson } from '../../../domain/json'
import type { RegistrationRepository } from '../../../application/ports/RegistrationPorts'
import {
  RegistrationError,
  CALENDAR_DISTANCE_MS,
  teamMemberIds,
  type RegistrationTournament,
  type RegistrationTeam,
} from '../../../domain/registration'
import type { Database } from './schema'
type Db = Kysely<Database> | Transaction<Database>

export class PostgresRegistrationRepository implements RegistrationRepository {
  constructor(private readonly db: Kysely<Database>) {}
  async list(): Promise<RegistrationTournament[]> {
    const rows = await this.db
      .selectFrom('tournaments')
      .select('id')
      .orderBy('starts_at', 'desc')
      .execute()
    return Promise.all(rows.map((x) => this.read(x.id)))
  }
  async create(
    t: RegistrationTournament,
    operationId: string,
    intent: string,
  ): Promise<RegistrationTournament> {
    return this.db.transaction().execute(async (tx) => {
      await sql
        .raw("SELECT pg_advisory_xact_lock(hashtextextended('tournament-calendar',0))")
        .execute(tx)
      const existing = await tx
        .selectFrom('tournament_admin_operations')
        .selectAll()
        .where('operation_id', '=', operationId)
        .executeTakeFirst()
      if (existing !== undefined) {
        if (existing.intent !== intent)
          throw new RegistrationError(
            'OPERATION_CONFLICT',
            'El identificador pertenece a otra intención.',
            409,
          )
        return this.load(tx, existing.tournament_id)
      }
      const dates = await tx.selectFrom('tournaments').select('starts_at').execute()
      if (
        dates.some(
          (x) =>
            Math.abs(x.starts_at.getTime() - new Date(t.startsAt).getTime()) < CALENDAR_DISTANCE_MS,
        )
      )
        throw new RegistrationError(
          'CALENDAR_CONFLICT',
          'Los inicios deben tener al menos 91 días de separación.',
          409,
        )
      await tx
        .insertInto('tournaments')
        .values({
          id: t.id,
          tournament_mode: t.tournamentMode ?? 'DUO',
          team_size: t.teamSize ?? 2,
          contract_version: t.contractVersion ?? 'torneos-hu77-84-78-hu83-v2.0.0',
          name: t.name,
          entry_policy: JSON.stringify(t.entryPolicy),
          entry_fee: t.entryFee,
          opens_at: new Date(t.opensAt),
          closes_at: new Date(t.closesAt),
          starts_at: new Date(t.startsAt),
          starts_epoch: new Date(t.startsAt).getTime(),
        })
        .execute()
      await tx
        .insertInto('tournament_admin_operations')
        .values({ operation_id: operationId, intent, tournament_id: t.id })
        .execute()
      return t
    })
  }
  read(id: string): Promise<RegistrationTournament> {
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute((tx) => this.load(tx, id))
  }
  private async load(db: Db, id: string): Promise<RegistrationTournament> {
    const t = await db.selectFrom('tournaments').selectAll().where('id', '=', id).executeTakeFirst()
    if (t === undefined)
      throw new RegistrationError('TOURNAMENT_NOT_FOUND', 'El torneo no existe.', 404)
    const teams = await db
      .selectFrom('registration_teams')
      .select('data')
      .where('tournament_id', '=', id)
      .orderBy('id')
      .execute()
    const ops = await db
      .selectFrom('registration_operations')
      .selectAll()
      .where('tournament_id', '=', id)
      .execute()
    return {
      id,
      tournamentMode: t.tournament_mode,
      teamSize: t.team_size,
      contractVersion: t.contract_version,
      name: t.name,
      entryPolicy: t.entry_policy,
      entryFee: t.entry_fee === null ? null : Number(t.entry_fee),
      opensAt: t.opens_at.toISOString(),
      closesAt: t.closes_at.toISOString(),
      startsAt: t.starts_at.toISOString(),
      bracket: t.bracket,
      teams: teams.map((x) => x.data),
      operations: Object.fromEntries(ops.map((x) => [x.operation_id, x.data])),
    }
  }
  async change<T>(id: string, action: (t: RegistrationTournament) => T): Promise<T> {
    try {
      return await this.db.transaction().execute(async (tx) => {
        await tx
          .selectFrom('tournaments')
          .select('id')
          .where('id', '=', id)
          .forUpdate()
          .executeTakeFirst()
        const t = await this.load(tx, id)
        const previousBracket = structuredClone(t.bracket)
        const result = action(t)
        if (previousBracket !== null && !sameJson(previousBracket, t.bracket))
          throw new RegistrationError(
            'IMMUTABLE_BRACKET',
            'Las llaves publicadas son inmutables.',
            409,
          )
        await tx.deleteFrom('registration_members').where('tournament_id', '=', id).execute()
        for (const team of t.teams) {
          const row = {
            id: team.id,
            tournament_id: id,
            owner_id: team.ownerId,
            companion_id: team.companionId,
            status: team.status,
            slot: team.slot,
            data: JSON.stringify(team),
          }
          await tx
            .insertInto('registration_teams')
            .values(row)
            .onConflict((c) => c.column('id').doUpdateSet(row))
            .execute()
          if (team.status !== 'CANCELLED') await this.members(tx, id, team)
        }
        for (const [operation_id, op] of Object.entries(t.operations))
          await tx
            .insertInto('registration_operations')
            .values({
              tournament_id: id,
              operation_id,
              intent: op.intent,
              team_id: op.teamId,
              data: JSON.stringify(op),
            })
            .onConflict((c) =>
              c
                .columns(['tournament_id', 'operation_id'])
                .doUpdateSet({ data: JSON.stringify(op) }),
            )
            .execute()
        if (previousBracket === null && t.bracket !== null)
          await tx
            .updateTable('tournaments')
            .set({ bracket: JSON.stringify(t.bracket) })
            .where('id', '=', id)
            .execute()
        return result
      })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : ''
      if (message.includes('ENCOUNTER_IDENTITY_CONFLICT'))
        throw new RegistrationError(
          'ENCOUNTER_IDENTITY_CONFLICT',
          'Ya existe una justa con esta identidad.',
          409,
        )
      if (message.includes('INVALID_BRACKET_ROSTER'))
        throw new RegistrationError(
          'INVALID_BRACKET_ROSTER',
          'El snapshot no corresponde a ocho equipos confirmados.',
          409,
        )
      throw error
    }
  }
  private async members(
    tx: Transaction<Database>,
    id: string,
    team: RegistrationTeam,
  ): Promise<void> {
    await tx
      .insertInto('registration_members')
      .values(
        teamMemberIds(team).map((player_id) => ({
          tournament_id: id,
          team_id: team.id,
          player_id,
        })),
      )
      .execute()
  }
}
