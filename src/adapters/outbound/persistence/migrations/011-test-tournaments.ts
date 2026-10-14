import { sql, type Migration } from 'kysely'

/** El piloto no ocupa el calendario oficial ni puede cambiar un torneo existente. */
export const migration: Migration = {
  up: async (db) => {
    await sql
      .raw(
        `
ALTER TABLE tournaments ADD COLUMN is_test boolean NOT NULL DEFAULT false;
ALTER TABLE tournaments DROP CONSTRAINT tournaments_calendar;
ALTER TABLE tournaments ADD CONSTRAINT tournaments_calendar EXCLUDE USING gist
  (int8range(starts_epoch, starts_epoch + 7862400000, '[)') WITH &&) WHERE (NOT is_test);
ALTER TABLE tournaments ADD CONSTRAINT test_tournaments_free CHECK
  (NOT is_test OR COALESCE(entry_policy='{"version":1,"free":true,"methods":[]}'::jsonb AND
    entry_fee=0 AND acceptance_policy='ROUND_ACCEPTANCE_V1' AND contract_version='torneos-v3.0.0',false));
CREATE FUNCTION guard_test_tournament() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.is_test IS DISTINCT FROM OLD.is_test THEN
    RAISE EXCEPTION 'IMMUTABLE_TOURNAMENT_CONFIGURATION' USING ERRCODE='23514';
  END IF;
  IF NEW.bracket IS NOT NULL AND COALESCE((NEW.bracket->>'isTest')::boolean,false) IS DISTINCT FROM NEW.is_test THEN
    RAISE EXCEPTION 'INVALID_TEST_BRACKET' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER test_tournament_guard BEFORE INSERT OR UPDATE ON tournaments
  FOR EACH ROW EXECUTE FUNCTION guard_test_tournament();
CREATE FUNCTION guard_test_tournament_prizes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT is_test FROM tournaments WHERE id=NEW.tournament_id) AND
    (NEW.data->'configuration' IS DISTINCT FROM 'null'::jsonb OR NEW.data->'delivery' IS DISTINCT FROM 'null'::jsonb) THEN
    RAISE EXCEPTION 'TEST_TOURNAMENT_NO_PRIZES' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER free_test_tournament_prize_guard BEFORE INSERT OR UPDATE ON tournament_lifecycle
  FOR EACH ROW EXECUTE FUNCTION guard_test_tournament_prizes();
`,
      )
      .execute(db)
  },
  down: () =>
    Promise.reject(new Error('011 es forward-only: conserva torneos de prueba y sus recibos.')),
}
