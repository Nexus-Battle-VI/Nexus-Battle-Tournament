import { sql, type Kysely } from 'kysely'
import { startTestPostgres } from '../support/postgres'
import { createDatabase, migrateToLatest } from '../../src/infrastructure/persistence/database'
import type { Database } from '../../src/adapters/outbound/persistence/schema'
import { PostgresRegistrationRepository } from '../../src/adapters/outbound/persistence/PostgresRegistrationRepository'
import { PostgresExternalLinksRepository } from '../../src/adapters/outbound/persistence/PostgresExternalLinksRepository'
import { ExternalLinks } from '../../src/application/use-cases/ExternalLinks'
import { bracketClock, tournamentFixture } from '../support/bracket-fixture'

const channel = 'https://www.youtube.com/channel/UCscW71t4iP--b-7HFDPFosA'
const live = 'https://www.youtube.com/watch?v=abcdefghijk'
describe('HU-82 — enlaces en PostgreSQL real', () => {
  let server: Awaited<ReturnType<typeof startTestPostgres>>,
    db: Kysely<Database>,
    service: ExternalLinks
  const connect = () => {
    db = createDatabase({ connectionString: server.connectionString })
    service = new ExternalLinks(
      new PostgresExternalLinksRepository(db),
      new PostgresRegistrationRepository(db),
      bracketClock,
    )
  }
  beforeAll(async () => {
    server = await startTestPostgres()
    connect()
    const result = await migrateToLatest(db)
    if (result.error)
      throw result.error instanceof Error ? result.error : new Error('Migration failed')
    await new PostgresRegistrationRepository(db).create(tournamentFixture(), 'create-T1', 'T1')
  })
  afterAll(async () => {
    await db.destroy()
    await server.stop()
  })
  it('sin publicación no crea fila; guardar y reiniciar conserva enlaces y fecha', async () => {
    expect((await service.view('T1')).revision).toBe(0)
    await service.save('T1', { liveUrl: null, youtubeArchiveUrl: null, expectedRevision: 0 })
    expect(await db.selectFrom('tournament_external_links').selectAll().execute()).toHaveLength(0)
    const command = { liveUrl: live, youtubeArchiveUrl: channel, expectedRevision: 0 }
    const saved = await service.save('T1', command)
    expect(await service.save('T1', command)).toEqual(saved)
    await db.destroy()
    connect()
    expect(await service.view('T1')).toEqual(saved)
  })
  it('dos pools corrigen simultáneamente: uno gana y el otro recibe conflicto', async () => {
    const second = createDatabase({ connectionString: server.connectionString })
    try {
      const other = new ExternalLinks(
        new PostgresExternalLinksRepository(second),
        new PostgresRegistrationRepository(second),
        bracketClock,
      )
      const outcomes = await Promise.allSettled([
        service.save('T1', {
          liveUrl: 'https://twitch.tv/nexus',
          youtubeArchiveUrl: channel,
          expectedRevision: 1,
        }),
        other.save('T1', {
          liveUrl: `${channel}/live`,
          youtubeArchiveUrl: channel,
          expectedRevision: 1,
        }),
      ])
      expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      const rejected = outcomes.find((r) => r.status === 'rejected')
      expect(rejected && 'reason' in rejected ? rejected.reason : null).toMatchObject({
        code: 'LINKS_CHANGED',
        status: 409,
      })
      expect((await service.view('T1')).revision).toBe(2)
    } finally {
      await second.destroy()
    }
  })
  it('SQL rechaza destinos no permitidos, parámetros secretos y revisión manipulada', async () => {
    const original = await service.view('T1')
    for (const url of [
      'javascript:alert(1)',
      `${live}&key=secret`,
      'https://youtube.com.evil.test/live',
      'https://studio.youtube.com/',
      'https://www.youtube.com/',
      'https://www.youtube.com:443/watch?v=abcdefghijk',
      `${live}#secret`,
    ]) {
      await expect(
        db
          .updateTable('tournament_external_links')
          .set({ live_url: url, revision: 3 })
          .where('tournament_id', '=', 'T1')
          .execute(),
      ).rejects.toThrow()
    }
    await expect(
      db
        .updateTable('tournament_external_links')
        .set({ youtube_archive_url: live, revision: 3 })
        .where('tournament_id', '=', 'T1')
        .execute(),
    ).rejects.toThrow()
    await expect(
      db
        .updateTable('tournament_external_links')
        .set({ revision: 1 })
        .where('tournament_id', '=', 'T1')
        .execute(),
    ).rejects.toThrow()
    await expect(
      db
        .updateTable('tournament_external_links')
        .set({ updated_at: new Date('2025-01-01') })
        .where('tournament_id', '=', 'T1')
        .execute(),
    ).rejects.toThrow()
    expect(await service.view('T1')).toEqual(original)
  })
  it('un adaptador inválido se revierte; un torneo inexistente no admite enlaces', async () => {
    const original = await service.view('T1')
    await expect(
      service.repository.change('T1', (state) => {
        state.liveUrl = 'https://evil.test/'
        state.revision++
      }),
    ).rejects.toMatchObject({ code: 'LINKS_INVALID' })
    expect(await service.view('T1')).toEqual(original)
    await expect(service.repository.change('unknown', () => null)).rejects.toMatchObject({
      status: 404,
    })
  })
  it('retirar el directo conserva acceso al archivo y solo persiste columnas de enlaces', async () => {
    const current = await service.view('T1')
    const next = await service.save('T1', {
      liveUrl: null,
      youtubeArchiveUrl: `${channel}/streams`,
      expectedRevision: current.revision,
    })
    expect(next.liveUrl).toBeNull()
    expect(next.youtubeArchiveUrl).toBe(`${channel}/streams`)
    await expect(
      service.save('T1', {
        liveUrl: 'https://twitch.tv/nexus',
        youtubeArchiveUrl: 'https://twitch.tv/nexus',
        expectedRevision: next.revision,
      }),
    ).rejects.toMatchObject({ code: 'LINKS_INVALID' })
    expect(await service.view('T1')).toEqual(next)
    const columns = await sql<{
      column_name: string
    }>`SELECT column_name FROM information_schema.columns WHERE table_name='tournament_external_links'`.execute(
      db,
    )
    expect(columns.rows.map((r) => r.column_name).sort()).toEqual([
      'live_url',
      'revision',
      'tournament_id',
      'updated_at',
      'youtube_archive_url',
    ])
  })
})
