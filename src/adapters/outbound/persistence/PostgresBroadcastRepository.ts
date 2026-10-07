import { sql, type Kysely } from 'kysely'
import type { BroadcastRepository } from '../../../application/ports/BroadcastPorts'
import { emptyBroadcast, type BroadcastState } from '../../../domain/broadcast'
import { RegistrationError } from '../../../domain/registration'
import type { Database } from './schema'
export class PostgresBroadcastRepository implements BroadcastRepository {
  constructor(private readonly db: Kysely<Database>) {}
  private async ready(): Promise<void> {
    const { rows } = await sql<{
      ready: boolean
    }>`select to_regclass('public.tournament_broadcasts') is not null as ready`.execute(this.db)
    if (!rows[0]?.ready)
      throw new RegistrationError(
        'BROADCAST_PERSISTENCE_UNAVAILABLE',
        'Falta aplicar la migración de emisión de Tournament.',
        503,
      )
  }
  async read(id: string): Promise<BroadcastState> {
    await this.ready()
    const row = await this.db
      .selectFrom('tournament_broadcasts')
      .select('data')
      .where('tournament_id', '=', id)
      .executeTakeFirst()
    return row ? row.data : emptyBroadcast(id)
  }
  async change<T>(id: string, action: (state: BroadcastState) => T): Promise<T> {
    await this.ready()
    return this.db
      .transaction()
      .execute(async (tx) => {
        const t = await tx
          .selectFrom('tournaments')
          .select('id')
          .where('id', '=', id)
          .forUpdate()
          .executeTakeFirst()
        if (!t) throw new RegistrationError('NOT_FOUND', 'El torneo no existe.', 404)
        const row = await tx
          .selectFrom('tournament_broadcasts')
          .select('data')
          .where('tournament_id', '=', id)
          .executeTakeFirst()
        const state = row ? row.data : emptyBroadcast(id)
        const result = action(state)
        if (row)
          await tx
            .updateTable('tournament_broadcasts')
            .set({ data: JSON.stringify(state) })
            .where('tournament_id', '=', id)
            .execute()
        else
          await tx
            .insertInto('tournament_broadcasts')
            .values({ tournament_id: id, data: JSON.stringify(state) })
            .execute()
        return result
      })
      .catch((error: unknown) => {
        if (
          error !== null &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === '23514'
        )
          throw new RegistrationError(
            'BROADCAST_CHANGED',
            'La justa o la selección cambió. Actualiza la vista antes de reintentar.',
            409,
          )
        throw error instanceof Error ? error : new Error(String(error))
      })
  }
}
