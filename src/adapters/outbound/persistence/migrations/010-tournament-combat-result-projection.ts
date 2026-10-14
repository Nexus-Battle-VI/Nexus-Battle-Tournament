import { sql, type Migration } from 'kysely'

/** Combat conserva el marcador completo; HU83 guarda solo su proyección de resultado. */
export const migration: Migration = {
  up: async (db) => {
    const { rows } = await sql<{
      definition: string
    }>`SELECT pg_get_functiondef('validate_tournament_lifecycle_v2()'::regprocedure) AS definition`.execute(
      db,
    )
    const definition = rows[0]?.definition
    const prior = "terminal->'result'=e.result"
    if (definition?.split(prior).length !== 2)
      throw new Error(
        'No se reconoce la validación del resultado; se conserva el esquema anterior.',
      )
    const projected = `(terminal->'result'->>'outcome'=e.result->>'outcome'
          AND terminal->'result'->>'reason'=e.result->>'reason'
          AND (terminal->'result'->>'winnerTeamLabel') IS NOT DISTINCT FROM (e.result->>'winnerTeamLabel')
          AND (terminal->'result'->>'finishedAt')::timestamptz=(e.result->>'finishedAt')::timestamptz)`
    await sql.raw(definition.replace(prior, projected)).execute(db)
  },
  down: () =>
    Promise.reject(new Error('010 es forward-only: conserva resultados y avance ya confirmados.')),
}
