import { sql, type Migration } from 'kysely'
import { up as lifecycleV3 } from './lifecycle-schema-v3'
export const migration: Migration = {
  up: async (db) => {
    await sql
      .raw(
        `
ALTER TABLE tournaments ADD COLUMN acceptance_policy text, ADD COLUMN round_windows jsonb NOT NULL DEFAULT '[]'::jsonb,
 ADD CONSTRAINT tournament_acceptance_policy CHECK (COALESCE(
 (acceptance_policy IS NULL AND round_windows='[]'::jsonb) OR
 (acceptance_policy='ROUND_ACCEPTANCE_V1' AND jsonb_typeof(round_windows)='array' AND jsonb_array_length(round_windows)=6),false));
CREATE FUNCTION tournament_schedule_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w jsonb; n int:=0;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.acceptance_policy,NEW.round_windows) IS DISTINCT FROM (OLD.acceptance_policy,OLD.round_windows) THEN
  RAISE EXCEPTION 'IMMUTABLE_TOURNAMENT_SCHEDULE' USING ERRCODE='23514'; END IF;
 IF NEW.acceptance_policy IS NOT NULL THEN
  FOR w IN SELECT value FROM jsonb_array_elements(NEW.round_windows) LOOP
   n:=n+1;
   IF NOT COALESCE((w->>'round')::int=n AND (w->>'acceptanceOpensAt')::timestamptz=NEW.starts_at+(n-1)*interval '10 minutes'
    AND (w->>'acceptanceClosesAt')::timestamptz=(w->>'acceptanceOpensAt')::timestamptz+interval '2 minutes'
    AND w->'scheduledStartAt'=w->'acceptanceClosesAt',false) THEN
     RAISE EXCEPTION 'INVALID_TOURNAMENT_SCHEDULE' USING ERRCODE='23514'; END IF;
  END LOOP;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER tournament_schedule_validation BEFORE INSERT OR UPDATE ON tournaments FOR EACH ROW EXECUTE FUNCTION tournament_schedule_guard();
CREATE FUNCTION attach_tournament_acceptance_policy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE policy text;
BEGIN
 SELECT acceptance_policy INTO policy FROM tournaments WHERE id=NEW.tournament_id;
 IF policy IS NOT NULL THEN NEW.bracket_metadata:=NEW.bracket_metadata||jsonb_build_object('acceptancePolicy',policy); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER tournament_encounter_policy BEFORE INSERT ON tournament_encounters FOR EACH ROW EXECUTE FUNCTION attach_tournament_acceptance_policy();
CREATE FUNCTION preserve_tournament_encounter_policy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t record;
BEGIN
 SELECT * INTO t FROM tournaments WHERE id=NEW.tournament_id;
 IF NEW.bracket_metadata->>'acceptancePolicy' IS DISTINCT FROM t.acceptance_policy OR
   (t.acceptance_policy='ROUND_ACCEPTANCE_V1' AND NOT COALESCE(NEW.bracket_metadata->>'tournamentMode'=t.tournament_mode
      AND (NEW.bracket_metadata->>'teamSize')::int=t.team_size,false)) THEN
   RAISE EXCEPTION 'IMMUTABLE_ENCOUNTER_ACCEPTANCE_POLICY' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER tournament_encounter_policy_guard BEFORE UPDATE ON tournament_encounters FOR EACH ROW EXECUTE FUNCTION preserve_tournament_encounter_policy();
CREATE TABLE tournament_match_acceptance (
 tournament_id text NOT NULL, encounter_id text NOT NULL, data jsonb NOT NULL,
 PRIMARY KEY(tournament_id,encounter_id),
 FOREIGN KEY(tournament_id,encounter_id) REFERENCES tournament_encounters(tournament_id,encounter_id),
 CHECK (COALESCE(data->>'tournamentId'=tournament_id AND data->>'encounterId'=encounter_id AND jsonb_typeof(data->'acceptances')='array'
  AND jsonb_typeof(data->'operations')='object' AND data->>'phase' IN ('SCHEDULED','OPEN','BLOCKED','CLOSED'),false)));
CREATE TABLE tournament_acceptances (
 tournament_id text NOT NULL,encounter_id text NOT NULL,subject text NOT NULL,team_id text NOT NULL,
 receipt_id text NOT NULL UNIQUE,operation_id text NOT NULL,accepted_at timestamptz NOT NULL,
 PRIMARY KEY(tournament_id,encounter_id,subject),
 FOREIGN KEY(tournament_id,encounter_id) REFERENCES tournament_match_acceptance(tournament_id,encounter_id));
CREATE TABLE tournament_acceptance_operations (
 tournament_id text NOT NULL,operation_id text NOT NULL,encounter_id text NOT NULL,subject text NOT NULL,receipt_id text NOT NULL,
 PRIMARY KEY(tournament_id,operation_id),
 FOREIGN KEY(tournament_id,encounter_id,subject) REFERENCES tournament_acceptances(tournament_id,encounter_id,subject));
CREATE TABLE tournament_resolutions (
 tournament_id text NOT NULL,encounter_id text NOT NULL,resolution_id text NOT NULL UNIQUE,data jsonb NOT NULL,
 PRIMARY KEY(tournament_id,encounter_id),FOREIGN KEY(tournament_id,encounter_id) REFERENCES tournament_match_acceptance(tournament_id,encounter_id),
 CHECK(COALESCE(data->>'tournamentId'=tournament_id AND data->>'encounterId'=encounter_id AND data->>'resolutionId'=resolution_id
  AND data->>'winnerTeamId'<>data->>'loserTeamId' AND data->'combatRoomId'='null'::jsonb AND data->>'ruleVersion'='ROUND_ACCEPTANCE_V1',false)));
CREATE FUNCTION immutable_tournament_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'IMMUTABLE_TOURNAMENT_DECISION' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND (OLD.data->'window' IS DISTINCT FROM NEW.data->'window' OR
  (OLD.data->'roster'<>'null'::jsonb AND OLD.data->'roster' IS DISTINCT FROM NEW.data->'roster') OR
  (OLD.data->>'openedAt' IS NOT NULL AND OLD.data->'openedAt' IS DISTINCT FROM NEW.data->'openedAt') OR
  (OLD.data->>'decidedAt' IS NOT NULL AND OLD.data->'decidedAt' IS DISTINCT FROM NEW.data->'decidedAt') OR
  (OLD.data->'combatIntent'<>'null'::jsonb AND (OLD.data->'combatIntent'->'prepareOperationId',OLD.data->'combatIntent'->'startOperationId')
    IS DISTINCT FROM (NEW.data->'combatIntent'->'prepareOperationId',NEW.data->'combatIntent'->'startOperationId')) OR
  (OLD.data->'combatIntent'->>'roomId' IS NOT NULL AND OLD.data->'combatIntent'->'roomId' IS DISTINCT FROM NEW.data->'combatIntent'->'roomId') OR
  (OLD.data->'combatIntent'->>'phase'='STARTED' AND NEW.data->'combatIntent'->>'phase'<>'STARTED') OR
  (OLD.data->>'decision' IS NOT NULL AND (OLD.data->'decision',OLD.data->'resolution') IS DISTINCT FROM (NEW.data->'decision',NEW.data->'resolution')) OR
  (OLD.data->>'phase'='BLOCKED' AND NEW.data->>'phase'<>'BLOCKED') OR
  (OLD.data->>'phase'='CLOSED' AND NEW.data->>'phase'<>'CLOSED') OR
  jsonb_array_length(NEW.data->'acceptances')<jsonb_array_length(OLD.data->'acceptances') OR EXISTS(
   SELECT 1 FROM jsonb_array_elements(OLD.data->'acceptances') WITH ORDINALITY x(v,n) WHERE v IS DISTINCT FROM NEW.data->'acceptances'->(n::int-1)) OR
  (OLD.data->>'decision' IS NOT NULL AND OLD.data->'acceptances' IS DISTINCT FROM NEW.data->'acceptances')) THEN
  RAISE EXCEPTION 'IMMUTABLE_TOURNAMENT_DECISION' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER tournament_decision_guard BEFORE UPDATE OR DELETE ON tournament_match_acceptance FOR EACH ROW EXECUTE FUNCTION immutable_tournament_decision();
CREATE FUNCTION immutable_acceptance_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_ACCEPTANCE_RECORD' USING ERRCODE='23514'; END $$;
CREATE TRIGGER accepted_player_immutable BEFORE UPDATE OR DELETE ON tournament_acceptances FOR EACH ROW EXECUTE FUNCTION immutable_acceptance_record();
CREATE TRIGGER accepted_operation_immutable BEFORE UPDATE OR DELETE ON tournament_acceptance_operations FOR EACH ROW EXECUTE FUNCTION immutable_acceptance_record();
CREATE TRIGGER tournament_resolution_immutable BEFORE UPDATE OR DELETE ON tournament_resolutions FOR EACH ROW EXECUTE FUNCTION immutable_acceptance_record();
CREATE FUNCTION validate_tournament_acceptance_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s jsonb; t record; e record; w jsonb; a jsonb; counts jsonb; winner text; side int; full_a boolean; full_b boolean; resolution jsonb; m jsonb; p jsonb; request jsonb;
BEGIN
 SELECT data INTO s FROM tournament_match_acceptance WHERE tournament_id=NEW.tournament_id AND encounter_id=NEW.encounter_id;
 SELECT * INTO t FROM tournaments WHERE id=NEW.tournament_id;
 SELECT * INTO e FROM tournament_encounters WHERE tournament_id=NEW.tournament_id AND encounter_id=NEW.encounter_id;
 SELECT value INTO m FROM jsonb_array_elements(t.bracket->'matches') WHERE value->>'encounterId'=NEW.encounter_id;
 SELECT data INTO p FROM tournament_lifecycle WHERE tournament_id=NEW.tournament_id;
 p:=COALESCE(p,'{"results":[]}'::jsonb);
 SELECT value INTO w FROM jsonb_array_elements(t.round_windows) WHERE (value->>'round')::int=e.round;
 IF NOT COALESCE(t.acceptance_policy='ROUND_ACCEPTANCE_V1' AND s->'window'=w AND s->>'tournamentMode'=t.tournament_mode
  AND (s->>'teamSize')::int=t.team_size,false) THEN RAISE EXCEPTION 'INVALID_ACCEPTANCE_POLICY' USING ERRCODE='23514'; END IF;
 IF NOT COALESCE(
   (s->>'phase'='SCHEDULED' AND s->'decision'='null'::jsonb AND s->'resolution'='null'::jsonb AND s->'combatIntent'='null'::jsonb AND s->'acceptances'='[]'::jsonb) OR
   (s->>'phase'='BLOCKED' AND s->'decision'='null'::jsonb AND s->'resolution'='null'::jsonb AND s->'combatIntent'='null'::jsonb) OR
   (s->>'phase'='OPEN' AND jsonb_typeof(s->'roster')='array' AND s->'decision'='null'::jsonb AND s->'resolution'='null'::jsonb AND s->'combatIntent'='null'::jsonb) OR
   (s->>'phase'='CLOSED' AND jsonb_typeof(s->'roster')='array' AND s->>'decision' IN ('COMBAT','TOURNAMENT')),false) THEN
   RAISE EXCEPTION 'INVALID_ACCEPTANCE_PHASE' USING ERRCODE='23514'; END IF;
 IF s->'roster'<>'null'::jsonb AND (jsonb_array_length(s->'roster')<>2 OR
   jsonb_build_array(s->'roster'->0->>'teamId',s->'roster'->1->>'teamId') IS DISTINCT FROM
    jsonb_build_array(tournament_progress_source(t.bracket,p,m->'sources'->0),tournament_progress_source(t.bracket,p,m->'sources'->1)) OR
   (SELECT count(DISTINCT x->>'teamId') FROM jsonb_array_elements(s->'roster') x)<>2 OR EXISTS(
    SELECT 1 FROM jsonb_array_elements(s->'roster') x WHERE x->'memberIds' IS DISTINCT FROM
     (SELECT v->'memberIds' FROM jsonb_array_elements(t.bracket->'seeds') v WHERE v->>'teamId'=x->>'teamId'))) THEN
    RAISE EXCEPTION 'INVALID_ACCEPTANCE_ROSTER' USING ERRCODE='23514'; END IF;
 IF s->>'phase' IN ('OPEN','CLOSED') AND NOT COALESCE((s->>'openedAt')::timestamptz>=(w->>'acceptanceOpensAt')::timestamptz
   AND (s->>'openedAt')::timestamptz<(w->>'acceptanceClosesAt')::timestamptz,false) THEN
   RAISE EXCEPTION 'INVALID_WINDOW_ACTIVATION' USING ERRCODE='23514'; END IF;
 IF s->>'phase' IN ('OPEN','CLOSED') AND NOT COALESCE((s->>'lastObservedAt')::timestamptz>=(s->>'openedAt')::timestamptz,false) THEN
   RAISE EXCEPTION 'INVALID_WINDOW_OBSERVATION' USING ERRCODE='23514'; END IF;
 IF s->>'phase' IN ('OPEN','CLOSED') AND EXISTS(SELECT 1 FROM jsonb_array_elements(m->'sources') src WHERE src->>'kind'<>'SEED' AND NOT EXISTS(
   SELECT 1 FROM jsonb_array_elements(p->'results') r WHERE r->>'matchId'=src->>'matchId' AND r->>'winnerTeamId' IS NOT NULL
     AND (r->>'confirmedAt')::timestamptz<=(w->>'acceptanceOpensAt')::timestamptz)) THEN
   RAISE EXCEPTION 'PREVIOUS_RESULT_PENDING' USING ERRCODE='23514'; END IF;
 IF (SELECT count(*) FROM tournament_acceptances WHERE tournament_id=NEW.tournament_id AND encounter_id=NEW.encounter_id)
   <>jsonb_array_length(s->'acceptances') THEN RAISE EXCEPTION 'INVALID_ACCEPTANCE_COUNTS' USING ERRCODE='23514'; END IF;
 FOR a IN SELECT value FROM jsonb_array_elements(s->'acceptances') LOOP
  IF NOT EXISTS(SELECT 1 FROM tournament_acceptances p WHERE p.tournament_id=NEW.tournament_id AND p.encounter_id=NEW.encounter_id AND p.subject=a->>'subject'
   AND p.team_id=a->>'teamId' AND p.receipt_id=a->>'receiptId' AND p.operation_id=a->>'operationId' AND p.accepted_at=(a->>'acceptedAt')::timestamptz
   AND p.accepted_at>=(w->>'acceptanceOpensAt')::timestamptz AND p.accepted_at<(w->>'acceptanceClosesAt')::timestamptz) OR
   NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'roster') x WHERE x->>'teamId'=a->>'teamId' AND x->'memberIds' ? (a->>'subject')) THEN
    RAISE EXCEPTION 'INVALID_PLAYER_ACCEPTANCE' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF jsonb_typeof(s->'pendingAcceptances') IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'INVALID_PENDING_ACCEPTANCE' USING ERRCODE='23514'; END IF;
 FOR request IN SELECT value FROM jsonb_array_elements(s->'pendingAcceptances') LOOP
  IF NOT COALESCE(length(request->>'requestId')>0 AND length(request->>'operationId')>0 AND
    (request->>'requestedAt')::timestamptz>=(w->>'acceptanceOpensAt')::timestamptz AND
    (request->>'requestedAt')::timestamptz<(w->>'acceptanceClosesAt')::timestamptz AND
    (request->'failedAt'='null'::jsonb OR (request->>'failedAt')::timestamptz>=(request->>'requestedAt')::timestamptz),false) OR NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(s->'roster') x WHERE x->'memberIds' ? (request->>'subject')) THEN
   RAISE EXCEPTION 'INVALID_PENDING_ACCEPTANCE' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF (SELECT count(*) FROM tournament_acceptance_operations WHERE tournament_id=NEW.tournament_id AND encounter_id=NEW.encounter_id)
   <>(SELECT count(*) FROM jsonb_each(s->'operations')) THEN RAISE EXCEPTION 'INVALID_ACCEPTANCE_OPERATIONS' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_each(s->'operations') op WHERE NOT EXISTS(
   SELECT 1 FROM tournament_acceptance_operations o JOIN tournament_acceptances a USING(tournament_id,encounter_id,subject)
   WHERE o.tournament_id=NEW.tournament_id AND o.encounter_id=NEW.encounter_id AND o.operation_id=op.key
     AND o.subject=op.value->>'subject' AND o.receipt_id=op.value->>'receiptId' AND o.receipt_id=a.receipt_id)) THEN
   RAISE EXCEPTION 'INVALID_ACCEPTANCE_OPERATIONS' USING ERRCODE='23514'; END IF;
 IF s->>'decision' IS NOT NULL THEN
  SELECT jsonb_agg(c ORDER BY n) INTO counts FROM (SELECT n,count(p.subject) AS c FROM jsonb_array_elements(s->'roster') WITH ORDINALITY x(v,n)
   LEFT JOIN tournament_acceptances p ON p.tournament_id=NEW.tournament_id AND p.encounter_id=NEW.encounter_id AND p.team_id=v->>'teamId' GROUP BY n) q;
  full_a:=(counts->>0)::int=t.team_size;full_b:=(counts->>1)::int=t.team_size;resolution:=s->'resolution';
  IF s->>'phase'<>'CLOSED' OR s->>'openedAt' IS NULL OR s->>'decidedAt' IS NULL OR
    (s->>'decidedAt')::timestamptz<(w->>'acceptanceClosesAt')::timestamptz THEN RAISE EXCEPTION 'ACCEPTANCE_CLOSE_REQUIRED' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(s->'pendingAcceptances') q(pending) WHERE NOT EXISTS(
    SELECT 1 FROM tournament_acceptances a WHERE a.tournament_id=NEW.tournament_id AND a.encounter_id=NEW.encounter_id AND a.subject=q.pending->>'subject')) THEN
   RAISE EXCEPTION 'UNCONFIRMED_ACCEPTANCE_REQUEST' USING ERRCODE='23514'; END IF;
  IF s->>'decision'='COMBAT' THEN
   IF NOT COALESCE(full_a AND full_b AND s->'resolution'='null'::jsonb AND s->'combatIntent'<>'null'::jsonb,false) THEN
    RAISE EXCEPTION 'COMPLETE_ACCEPTANCE_REQUIRED' USING ERRCODE='23514'; END IF;
  ELSE
   IF full_a AND full_b OR resolution->'acceptedCounts' IS DISTINCT FROM counts OR
     resolution->'teamIds' IS DISTINCT FROM jsonb_build_array(s->'roster'->0->>'teamId',s->'roster'->1->>'teamId') OR
     s->'combatIntent'<>'null'::jsonb OR resolution->'resolvedAt' IS DISTINCT FROM s->'decidedAt' OR
     (resolution->>'resolvedAt')::timestamptz<(w->>'acceptanceClosesAt')::timestamptz OR
     NOT EXISTS(SELECT 1 FROM tournament_resolutions r WHERE r.tournament_id=NEW.tournament_id AND r.encounter_id=NEW.encounter_id AND r.data=resolution) THEN
    RAISE EXCEPTION 'INVALID_ABSENCE_RESOLUTION' USING ERRCODE='23514'; END IF;
   IF full_a OR full_b THEN side:=CASE WHEN full_a THEN 0 ELSE 1 END;
    IF resolution->>'rule'<>'COMPLETE_TEAM' OR resolution->>'reason'<>'ABSENCE_OPPONENT_INCOMPLETE' OR resolution->>'coinBit' IS NOT NULL THEN RAISE EXCEPTION 'INVALID_ABSENCE_RULE' USING ERRCODE='23514'; END IF;
   ELSIF counts->0<>counts->1 THEN side:=CASE WHEN (counts->>0)::int>(counts->>1)::int THEN 0 ELSE 1 END;
    IF resolution->>'rule'<>'MORE_ACCEPTANCES' OR resolution->>'reason'<>'ABSENCE_MORE_ACCEPTANCES' OR resolution->>'coinBit' IS NOT NULL THEN RAISE EXCEPTION 'INVALID_ABSENCE_RULE' USING ERRCODE='23514'; END IF;
   ELSE
    IF NOT COALESCE(resolution->>'rule'='FAIR_COIN' AND resolution->>'reason'='ABSENCE_TIED_ACCEPTANCES' AND resolution->>'coinBit' IN ('0','1'),false) THEN RAISE EXCEPTION 'INVALID_ABSENCE_RULE' USING ERRCODE='23514'; END IF;
    side:=(resolution->>'coinBit')::int;
   END IF;
   winner:=s->'roster'->side->>'teamId';
   IF resolution->>'winnerTeamId' IS DISTINCT FROM winner OR resolution->>'loserTeamId' IS DISTINCT FROM s->'roster'->(1-side)->>'teamId' THEN
    RAISE EXCEPTION 'INVALID_ABSENCE_WINNER' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER acceptance_state_validation AFTER INSERT OR UPDATE ON tournament_match_acceptance
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_tournament_acceptance_state();
CREATE CONSTRAINT TRIGGER acceptance_record_validation AFTER INSERT ON tournament_acceptances
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_tournament_acceptance_state();
CREATE CONSTRAINT TRIGGER resolution_record_validation AFTER INSERT ON tournament_resolutions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_tournament_acceptance_state();
`,
      )
      .execute(db)
    await lifecycleV3(db)
  },
  down: () =>
    Promise.reject(
      new Error('007 es forward-only: preservar aceptaciones, decisiones y resoluciones.'),
    ),
}
