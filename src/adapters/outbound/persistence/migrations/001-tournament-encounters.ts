import { sql, type Kysely, type Migration } from 'kysely'

/**
 * Primeras tablas propias de Tournament: HU-83 (Management#465), registro y
 * consulta de justas.
 *
 * `tournament_encounters` guarda la instantanea de cada justa. La clave
 * primaria compuesta `(tournament_id, encounter_id)` impide que dos torneos
 * simultaneos colisionen (CA-01).
 *
 * `tournament_combat_events` es la proyeccion de solo-anadir de los eventos de
 * Combat. La restriccion unica `(tournament_id, encounter_id, seq)` es la
 * barrera, a nivel de motor, contra reescribir o duplicar un evento ya
 * guardado: un `INSERT` con la misma clave falla con una violacion de
 * unicidad, que el adaptador interpreta como "ya lo tengo" (CA-03). Esa misma
 * restriccion unica YA es el indice que ordena `(tournament_id, encounter_id,
 * seq)`, asi que no hace falta un segundo indice normal con las mismas
 * columnas para leer la pagina de eventos en orden.
 */
export const migration001TournamentEncounters: Migration = {
  up: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema
      .createTable('tournament_encounters')
      .addColumn('tournament_id', 'text', (col) => col.notNull())
      .addColumn('encounter_id', 'text', (col) => col.notNull())
      .addColumn('round', 'integer', (col) => col.notNull())
      .addColumn('bracket_label', 'text', (col) => col.notNull())
      .addColumn('teams', 'jsonb', (col) => col.notNull())
      .addColumn('status', 'text', (col) => col.notNull())
      .addColumn('combat_room_id', 'text')
      .addColumn('started_at', 'timestamptz')
      .addColumn('closed_at', 'timestamptz')
      .addColumn('result', 'jsonb')
      .addColumn('last_synced_seq', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('log_complete', 'boolean', (col) => col.notNull().defaultTo(false))
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addPrimaryKeyConstraint('tournament_encounters_pk', ['tournament_id', 'encounter_id'])
      .execute()

    await db.schema
      .createTable('tournament_combat_events')
      .addColumn('id', 'serial', (col) => col.primaryKey())
      .addColumn('tournament_id', 'text', (col) => col.notNull())
      .addColumn('encounter_id', 'text', (col) => col.notNull())
      .addColumn('seq', 'integer', (col) => col.notNull())
      .addColumn('type', 'text', (col) => col.notNull())
      .addColumn('payload', 'jsonb', (col) => col.notNull())
      .addColumn('occurred_at', 'timestamptz', (col) => col.notNull())
      .addColumn('recorded_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .addForeignKeyConstraint(
        'tournament_combat_events_encounter_fk',
        ['tournament_id', 'encounter_id'],
        'tournament_encounters',
        ['tournament_id', 'encounter_id'],
        (fk) => fk.onDelete('cascade'),
      )
      .execute()

    // Barrera de unicidad/orden: el guardian real de CA-03, no solo el dominio.
    // Cubre tambien la lectura paginada en orden: no hace falta otro indice
    // normal con las mismas columnas.
    await db.schema
      .createIndex('tournament_combat_events_seq_unique')
      .on('tournament_combat_events')
      .columns(['tournament_id', 'encounter_id', 'seq'])
      .unique()
      .execute()
  },

  down: async (db: Kysely<unknown>): Promise<void> => {
    await db.schema.dropTable('tournament_combat_events').execute()
    await db.schema.dropTable('tournament_encounters').execute()
  },
}
