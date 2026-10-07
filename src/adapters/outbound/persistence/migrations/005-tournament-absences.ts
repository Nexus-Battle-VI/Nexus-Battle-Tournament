import { sql, type Migration } from 'kysely'

/**
 * Ventana de aceptación y avance por ausencia (decisión de Carlos sobre HU-85).
 * Solo de adición. `PRIMARY KEY (torneo, justa, jugador)` hace idempotente la
 * aceptación y `PRIMARY KEY (torneo, justa)` garantiza una sola resolución por
 * justa aunque dos instancias barran a la vez.
 */
export const migration: Migration = {
  up: async (db) => {
    await sql
      .raw(
        `
CREATE TABLE tournament_encounter_readiness (
 tournament_id text NOT NULL,
 encounter_id text NOT NULL,
 player_id text NOT NULL,
 accepted_at timestamptz NOT NULL,
 PRIMARY KEY (tournament_id, encounter_id, player_id),
 CONSTRAINT tournament_encounter_readiness_encounter
  FOREIGN KEY (tournament_id, encounter_id)
  REFERENCES tournament_encounters (tournament_id, encounter_id)
);
CREATE TABLE tournament_encounter_absences (
 tournament_id text NOT NULL,
 encounter_id text NOT NULL,
 winner_team_id text NOT NULL,
 kind text NOT NULL,
 ready_counts jsonb NOT NULL,
 resolved_at timestamptz NOT NULL,
 PRIMARY KEY (tournament_id, encounter_id),
 CONSTRAINT tournament_encounter_absences_kind
  CHECK (kind IN ('ONE_TEAM_READY','MORE_PLAYERS_READY','DRAW')),
 CONSTRAINT tournament_encounter_absences_encounter
  FOREIGN KEY (tournament_id, encounter_id)
  REFERENCES tournament_encounters (tournament_id, encounter_id)
);
`,
      )
      .execute(db)
  },
  down: async (db) => {
    await sql
      .raw('DROP TABLE tournament_encounter_absences; DROP TABLE tournament_encounter_readiness')
      .execute(db)
  },
}
