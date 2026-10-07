import { sql, type Kysely } from 'kysely'
import {
  emptyLifecycle,
  type LifecycleRepository,
  type TournamentLifecycle,
} from '../../../application/ports/LifecyclePorts'
import { RegistrationError } from '../../../domain/registration'
import type { Database } from './schema'
export class PostgresLifecycleRepository implements LifecycleRepository {
  constructor(private readonly db: Kysely<Database>) {}
  private async ready(): Promise<void> {
    const { rows } = await sql<{
      ready: boolean
    }>`select to_regclass('public.tournament_lifecycle') is not null as ready`.execute(this.db)
    if (!rows[0]?.ready)
      throw new RegistrationError(
        'HU85_DELIVERY_PENDING',
        'El candidato de progreso/premios espera la composición de migraciones con HU-85.',
        503,
      )
  }
  async read(id: string): Promise<TournamentLifecycle> {
    await this.ready()
    const row = await this.db
      .selectFrom('tournament_lifecycle')
      .select('data')
      .where('tournament_id', '=', id)
      .executeTakeFirst()
    return row ? row.data : emptyLifecycle(id)
  }
  async change<T>(id: string, action: (state: TournamentLifecycle) => T): Promise<T> {
    await this.ready()
    return this.db.transaction().execute(async (tx) => {
      const exists = await tx
        .selectFrom('tournaments')
        .select('id')
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!exists) throw new RegistrationError('NOT_FOUND', 'El torneo no existe.', 404)
      const row = await tx
        .selectFrom('tournament_lifecycle')
        .select('data')
        .where('tournament_id', '=', id)
        .executeTakeFirst()
      const state = row ? row.data : emptyLifecycle(id)
      const result = action(state)
      await tx
        .insertInto('tournament_lifecycle')
        .values({ tournament_id: id, data: JSON.stringify(state) })
        .onConflict((c) => c.column('tournament_id').doUpdateSet({ data: JSON.stringify(state) }))
        .execute()
      return result
    })
  }
  async pendingDeliveries(): Promise<string[]> {
    await this.ready()
    const rows = await this.db
      .selectFrom('tournament_lifecycle')
      .select(['tournament_id', 'data'])
      .execute()
    return rows
      .filter((r) =>
        r.data.delivery?.lines.some(
          (l) =>
            l.status === 'PENDING' &&
            !['PRIZE_DESTINATION_CONFLICT', 'PRIZE_RECEIPT_CONFLICT'].includes(l.lastError ?? ''),
        ),
      )
      .map((r) => r.tournament_id)
  }
}
