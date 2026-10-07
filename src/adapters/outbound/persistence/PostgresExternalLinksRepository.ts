import type { Kysely, Selectable } from 'kysely'
import type { ExternalLinksRepository } from '../../../application/ports/ExternalLinksPorts'
import { emptyExternalLinks, type ExternalLinksState } from '../../../domain/external-links'
import { RegistrationError } from '../../../domain/registration'
import type { Database } from './schema'
const fromRow = (row: Selectable<Database['tournament_external_links']>): ExternalLinksState => ({
  tournamentId: row.tournament_id,
  liveUrl: row.live_url,
  youtubeArchiveUrl: row.youtube_archive_url,
  revision: Number(row.revision),
  updatedAt: row.updated_at.toISOString(),
})
export class PostgresExternalLinksRepository implements ExternalLinksRepository {
  constructor(private readonly db: Kysely<Database>) {}
  async read(id: string): Promise<ExternalLinksState> {
    const row = await this.db
      .selectFrom('tournament_external_links')
      .selectAll()
      .where('tournament_id', '=', id)
      .executeTakeFirst()
    return row ? fromRow(row) : emptyExternalLinks(id)
  }
  change<T>(id: string, action: (state: ExternalLinksState) => T): Promise<T> {
    return this.db
      .transaction()
      .execute(async (tx) => {
        const tournament = await tx
          .selectFrom('tournaments')
          .select('id')
          .where('id', '=', id)
          .forUpdate()
          .executeTakeFirst()
        if (!tournament) throw new RegistrationError('NOT_FOUND', 'El torneo no existe.', 404)
        const row = await tx
          .selectFrom('tournament_external_links')
          .selectAll()
          .where('tournament_id', '=', id)
          .executeTakeFirst()
        const state = row ? fromRow(row) : emptyExternalLinks(id)
        const result = action(state)
        // An unchanged retry never changes the timestamp or creates an empty publication.
        if (state.revision === (row ? Number(row.revision) : 0)) return result
        if (state.updatedAt === null)
          throw new RegistrationError(
            'LINKS_INVALID',
            'Falta la fecha de publicación de los enlaces.',
            422,
          )
        const values = {
          live_url: state.liveUrl,
          youtube_archive_url: state.youtubeArchiveUrl,
          revision: state.revision,
          updated_at: new Date(state.updatedAt),
        }
        if (row)
          await tx
            .updateTable('tournament_external_links')
            .set(values)
            .where('tournament_id', '=', id)
            .execute()
        else
          await tx
            .insertInto('tournament_external_links')
            .values({ tournament_id: id, ...values })
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
            'LINKS_INVALID',
            'La base de datos rechazó los enlaces o su revisión; se conservaron los valores anteriores.',
            422,
          )
        throw error instanceof Error ? error : new Error(String(error))
      })
  }
}
