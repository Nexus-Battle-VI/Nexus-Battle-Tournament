import { sql, type Migration } from 'kysely'

export const migration: Migration = {
  up: async (db) => {
    await sql
      .raw(
        `
CREATE TABLE tournaments (
 id text PRIMARY KEY, name text NOT NULL,
 entry_policy jsonb NOT NULL, entry_fee bigint,
 opens_at timestamptz NOT NULL, closes_at timestamptz NOT NULL, starts_at timestamptz NOT NULL,
 starts_epoch bigint NOT NULL,
 CONSTRAINT tournaments_dates CHECK (opens_at < closes_at AND closes_at <= starts_at),
 CONSTRAINT tournaments_epoch CHECK (starts_epoch = floor(extract(epoch FROM starts_at) * 1000)::bigint),
 CONSTRAINT tournaments_calendar EXCLUDE USING gist
  (int8range(starts_epoch, starts_epoch + 7862400000, '[)') WITH &&)
);
CREATE TABLE tournament_admin_operations (
 operation_id text PRIMARY KEY, intent text NOT NULL,
 tournament_id text NOT NULL REFERENCES tournaments(id)
);
CREATE TABLE registration_teams (
 id text PRIMARY KEY, tournament_id text NOT NULL REFERENCES tournaments(id),
 owner_id text NOT NULL, companion_id text NOT NULL,
 status text NOT NULL, slot integer, data jsonb NOT NULL,
 UNIQUE(tournament_id,id), UNIQUE(tournament_id,slot),
 CONSTRAINT registration_distinct_members CHECK (owner_id <> companion_id),
 CONSTRAINT registration_slot CHECK (slot BETWEEN 1 AND 8),
 CONSTRAINT registration_status CHECK (status IN
  ('AWAITING_CONSENT','PENDING_PAYMENT','PAYMENT_PENDING','COMPENSATING','CONFIRMED','CANCELLED')),
 CONSTRAINT registration_slot_state CHECK
  ((status IN ('PAYMENT_PENDING','COMPENSATING','CONFIRMED')) = (slot IS NOT NULL)),
 CONSTRAINT registration_row_data CHECK
  (data->>'id' IS NOT DISTINCT FROM id AND data->>'ownerId' IS NOT DISTINCT FROM owner_id
   AND data->>'companionId' IS NOT DISTINCT FROM companion_id
   AND data->>'status' IS NOT DISTINCT FROM status AND (data->>'slot')::integer IS NOT DISTINCT FROM slot)
);
CREATE TABLE registration_members (
 tournament_id text NOT NULL, team_id text NOT NULL, player_id text NOT NULL,
 PRIMARY KEY(tournament_id,player_id),
 FOREIGN KEY(tournament_id,team_id) REFERENCES registration_teams(tournament_id,id)
);
CREATE TABLE registration_operations (
 tournament_id text NOT NULL REFERENCES tournaments(id), operation_id text NOT NULL,
 intent text NOT NULL, team_id text NOT NULL, data jsonb NOT NULL,
 PRIMARY KEY(tournament_id,operation_id)
);
`,
      )
      .execute(db)
  },
  down: async (db) => {
    await sql
      .raw(
        `
DROP TABLE registration_operations; DROP TABLE registration_members; DROP TABLE registration_teams; DROP TABLE tournament_admin_operations; DROP TABLE tournaments;
`,
      )
      .execute(db)
  },
}
