import { sql, type Kysely } from 'kysely'
/** Migración forward posterior a calendario/aceptación: emisión HU-79/81. */
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await sql`CREATE TABLE tournament_broadcasts (
    tournament_id text PRIMARY KEY REFERENCES tournaments(id),data jsonb NOT NULL,
    CHECK(COALESCE(data->>'tournamentId'=tournament_id AND jsonb_typeof(data->'revision')='number'
      AND (data->>'revision')::bigint>=1 AND (data->>'revision')::bigint<9007199254740991
      AND data ?& ARRAY['broadcasterId','selectedMatchId'] AND length(trim(data->>'broadcasterId'))>0
      AND (data->'selectedMatchId'='null'::jsonb OR
        (jsonb_typeof(data->'selectedMatchId')='string' AND length(data->>'selectedMatchId') BETWEEN 1 AND 512)),false)))`.execute(
    db,
  )
  await sql`CREATE FUNCTION validate_tournament_broadcast_v2() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE changed boolean; next_match text; expected_revision bigint;
    BEGIN
      next_match:=NEW.data->>'selectedMatchId';
      IF TG_OP='UPDATE' THEN
        changed:=OLD.data->'broadcasterId' IS DISTINCT FROM NEW.data->'broadcasterId' OR
          OLD.data->'selectedMatchId' IS DISTINCT FROM NEW.data->'selectedMatchId';
        expected_revision:=(OLD.data->>'revision')::bigint;IF changed THEN expected_revision:=expected_revision+1;END IF;
        IF OLD.tournament_id<>NEW.tournament_id OR (NEW.data->>'revision')::bigint<>expected_revision THEN
          RAISE EXCEPTION 'Broadcast revision must follow selection' USING ERRCODE='23514'; END IF;
      ELSIF (NEW.data->>'revision')::bigint<>1 THEN
        RAISE EXCEPTION 'Designation starts at revision one' USING ERRCODE='23514'; END IF;
      IF next_match IS NOT NULL AND (TG_OP='INSERT' OR OLD.data->>'selectedMatchId' IS DISTINCT FROM next_match) THEN
        IF NOT EXISTS(SELECT 1 FROM tournament_encounters WHERE tournament_id=NEW.tournament_id AND encounter_id=next_match
          AND status='IN_PROGRESS' AND combat_room_id IS NOT NULL) THEN
          RAISE EXCEPTION 'Selection requires active official encounter' USING ERRCODE='23514'; END IF;
      END IF;
      RETURN NEW;
    END $$`.execute(db)
  await sql`CREATE TRIGGER broadcast_validation BEFORE INSERT OR UPDATE ON tournament_broadcasts
    FOR EACH ROW EXECUTE FUNCTION validate_tournament_broadcast_v2()`.execute(db)
}
export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('tournament_broadcasts').execute()
  await sql`DROP FUNCTION validate_tournament_broadcast_v2()`.execute(db)
}
