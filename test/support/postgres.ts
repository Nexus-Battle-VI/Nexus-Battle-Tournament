import { randomUUID } from 'node:crypto'
import { PostgreSqlContainer } from '@testcontainers/postgresql'
import { sql } from 'kysely'
import { createDatabase } from '../../src/infrastructure/persistence/database'

/** Always isolated, even when a caller supplies an existing local PostgreSQL server. */
export const startTestPostgres = async (): Promise<{
  connectionString: string
  stop: () => Promise<void>
}> => {
  const configured = process.env.TEST_DATABASE_URL
  if (!configured) {
    const container = await new PostgreSqlContainer('postgres:17-alpine').start()
    return {
      connectionString: container.getConnectionUri(),
      stop: () => container.stop().then(() => undefined),
    }
  }
  const name = `hu77_${randomUUID().replaceAll('-', '')}`
  const admin = createDatabase({ connectionString: configured })
  await sql`CREATE DATABASE ${sql.id(name)}`.execute(admin)
  const url = new URL(configured)
  url.pathname = `/${name}`
  return {
    connectionString: url.toString(),
    stop: async () => {
      await sql`DROP DATABASE ${sql.id(name)}`.execute(admin)
      await admin.destroy()
    },
  }
}
