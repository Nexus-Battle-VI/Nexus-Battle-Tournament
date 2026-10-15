import { sql, type Migration } from 'kysely'

/** Administradores sin separación de fechas; cierre durable sin inventar resultados. */
export const migration: Migration = {
  up: async (db) => {
    await sql
      .raw(
        `
ALTER TABLE tournaments DROP CONSTRAINT tournaments_calendar;
ALTER TABLE tournaments ADD COLUMN closure jsonb;
ALTER TABLE tournaments ADD COLUMN last_activity_at timestamptz;
UPDATE tournaments t SET last_activity_at = (
  SELECT max(at) FROM (
    SELECT accepted_at AS at FROM tournament_acceptances WHERE tournament_id=t.id
    UNION ALL
    SELECT occurred_at AS at FROM tournament_combat_events WHERE tournament_id=t.id
      AND type IN ('battleStarted','basicAttackResolved','skillUsed')
  ) activity
);
CREATE FUNCTION guard_tournament_closure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_line jsonb; new_line jsonb;
BEGIN
  IF NEW.closure IS NOT NULL AND (jsonb_typeof(NEW.closure)<>'object' OR
    NOT COALESCE(NEW.closure->>'reason' IN ('INACTIVITY','ADMINISTRATIVE'),false) OR
    COALESCE(NEW.closure->>'operationId','')='' OR COALESCE(NEW.closure->>'actor','')='' OR
    COALESCE(NEW.closure->>'closedAt','')='' OR COALESCE(NEW.closure->>'lastActivityAt','')='' OR
    jsonb_typeof(NEW.closure->'refunds') IS DISTINCT FROM 'array') THEN
    RAISE EXCEPTION 'INVALID_TOURNAMENT_CLOSURE' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND OLD.closure IS NOT NULL THEN
    IF NEW.bracket IS DISTINCT FROM OLD.bracket THEN
      RAISE EXCEPTION 'TOURNAMENT_CLOSED' USING ERRCODE='23514';
    END IF;
    IF NEW.closure IS NULL OR (NEW.closure-'refunds') IS DISTINCT FROM (OLD.closure-'refunds') OR
      jsonb_array_length(NEW.closure->'refunds')<>jsonb_array_length(OLD.closure->'refunds') THEN
      RAISE EXCEPTION 'IMMUTABLE_TOURNAMENT_CLOSURE' USING ERRCODE='23514';
    END IF;
    FOR old_line IN SELECT value FROM jsonb_array_elements(OLD.closure->'refunds') LOOP
      SELECT value INTO new_line FROM jsonb_array_elements(NEW.closure->'refunds')
        WHERE value->>'teamId'=old_line->>'teamId';
      IF new_line IS NULL OR
        (old_line-ARRAY['chargeId','status','refundedAt','lastError','receipt']) IS DISTINCT FROM
        (new_line-ARRAY['chargeId','status','refundedAt','lastError','receipt']) OR
        (old_line->>'chargeId' IS NOT NULL AND old_line->'chargeId' IS DISTINCT FROM new_line->'chargeId') OR
        (old_line->>'status'='REFUNDED' AND old_line IS DISTINCT FROM new_line) THEN
        RAISE EXCEPTION 'IMMUTABLE_ENTRY_REFUND' USING ERRCODE='23514';
      END IF;
    END LOOP;
  ELSIF NEW.closure IS NOT NULL AND EXISTS (
    SELECT 1 FROM tournament_lifecycle WHERE tournament_id=NEW.id
      AND COALESCE(data->'champion','null'::jsonb)<>'null'::jsonb
  ) THEN
    RAISE EXCEPTION 'TOURNAMENT_COMPLETED' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND OLD.last_activity_at IS NOT NULL AND
    (NEW.last_activity_at IS NULL OR NEW.last_activity_at<OLD.last_activity_at) THEN
    RAISE EXCEPTION 'ACTIVITY_CANNOT_REGRESS' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tournament_closure_guard BEFORE INSERT OR UPDATE ON tournaments
  FOR EACH ROW EXECUTE FUNCTION guard_tournament_closure();
CREATE FUNCTION touch_tournament_activity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='tournament_acceptances' THEN
    UPDATE tournaments SET last_activity_at=GREATEST(last_activity_at,NEW.accepted_at)
      WHERE id=NEW.tournament_id AND closure IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'TOURNAMENT_CLOSED' USING ERRCODE='23514'; END IF;
  ELSIF NEW.type IN ('battleStarted','basicAttackResolved','skillUsed') THEN
    UPDATE tournaments SET last_activity_at=GREATEST(last_activity_at,NEW.occurred_at)
      WHERE id=NEW.tournament_id AND closure IS NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tournament_acceptance_activity AFTER INSERT ON tournament_acceptances
  FOR EACH ROW EXECUTE FUNCTION touch_tournament_activity();
CREATE TRIGGER tournament_combat_activity AFTER INSERT ON tournament_combat_events
  FOR EACH ROW EXECUTE FUNCTION touch_tournament_activity();
CREATE FUNCTION guard_closed_tournament_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT closure IS NOT NULL FROM tournaments WHERE id=NEW.tournament_id) AND
    (TG_OP='INSERT' OR NEW.data IS DISTINCT FROM OLD.data) THEN
    RAISE EXCEPTION 'TOURNAMENT_CLOSED' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER closed_tournament_lifecycle_guard BEFORE INSERT OR UPDATE ON tournament_lifecycle
  FOR EACH ROW EXECUTE FUNCTION guard_closed_tournament_lifecycle();
`,
      )
      .execute(db)
  },
  down: () => Promise.reject(new Error('012 es forward-only: conserva cierres y reembolsos.')),
}
