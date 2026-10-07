import { sql, type Migration } from 'kysely'

/**
 * HU-85 (Management#470): recibos de las acciones administrativas aceptadas
 * sobre una justa. Solo de adicion: no toca las tablas de HU-83/77/78.
 * `UNIQUE(tournament, encounter, action)` garantiza a nivel de motor que una
 * justa nunca tiene dos recibos de Preparar ni dos de Iniciar (CA-04).
 */
export const migration: Migration = {
  up: async (db) => {
    await sql
      .raw(
        `
CREATE TABLE tournament_encounter_actions (
 action_id uuid PRIMARY KEY,
 tournament_id text NOT NULL,
 encounter_id text NOT NULL,
 action text NOT NULL,
 actor text NOT NULL,
 operation_id text NOT NULL,
 combat_room_id text NOT NULL,
 occurred_at timestamptz NOT NULL,
 CONSTRAINT tournament_encounter_actions_action CHECK (action IN ('PREPARE','START')),
 CONSTRAINT tournament_encounter_actions_encounter
  FOREIGN KEY (tournament_id, encounter_id)
  REFERENCES tournament_encounters (tournament_id, encounter_id),
 CONSTRAINT tournament_encounter_actions_once UNIQUE (tournament_id, encounter_id, action),
 CONSTRAINT tournament_encounter_actions_operation UNIQUE (tournament_id, operation_id)
);
CREATE INDEX tournament_encounter_actions_time
 ON tournament_encounter_actions (tournament_id, occurred_at);
`,
      )
      .execute(db)
  },
  down: async (db) => {
    await sql.raw('DROP TABLE tournament_encounter_actions').execute(db)
  },
}
