import { sql, type Migration } from 'kysely'
import { up as lifecycleUp } from './lifecycle-schema'

/** 001–004 publicados se conservan. 005 queda reservado para enlaces externos. */
export const migration: Migration = {
  up: async (db) => {
    await sql
      .raw(
        `
ALTER TABLE tournaments ADD COLUMN tournament_mode text NOT NULL DEFAULT 'DUO',
 ADD COLUMN team_size integer NOT NULL DEFAULT 2,
 ADD COLUMN contract_version text NOT NULL DEFAULT 'torneos-hu77-84-78-hu83-v2.0.0',
 ADD CONSTRAINT tournament_mode_size CHECK ((tournament_mode='SOLO' AND team_size=1)
   OR (tournament_mode='DUO' AND team_size=2) OR (tournament_mode='TRIO' AND team_size=3));
ALTER TABLE registration_teams ALTER COLUMN companion_id DROP NOT NULL;
UPDATE registration_teams SET data=data || jsonb_build_object('members', jsonb_build_array(
 jsonb_build_object('subject',owner_id,'position',0,'consentAt',data->'ownerConsentAt','consentVersion',data->'ownerConsentVersion'),
 jsonb_build_object('subject',companion_id,'position',1,'consentAt',data->'consentAt','consentVersion',data->'consentVersion')));
CREATE FUNCTION immutable_tournament_configuration() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.tournament_mode,NEW.team_size,NEW.contract_version,NEW.starts_at) IS DISTINCT FROM
    (OLD.tournament_mode,OLD.team_size,OLD.contract_version,OLD.starts_at) THEN
  RAISE EXCEPTION 'IMMUTABLE_TOURNAMENT_CONFIGURATION' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER tournament_configuration_guard BEFORE UPDATE ON tournaments
 FOR EACH ROW EXECUTE FUNCTION immutable_tournament_configuration();
CREATE FUNCTION validate_registration_members_v3() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tid text; team record; expected int;
BEGIN
 tid:=COALESCE(NEW.tournament_id,OLD.tournament_id);
 SELECT team_size INTO expected FROM tournaments WHERE id=tid;
 FOR team IN SELECT * FROM registration_teams WHERE tournament_id=tid LOOP
  IF jsonb_typeof(team.data->'members') IS DISTINCT FROM 'array' OR
    jsonb_array_length(team.data->'members')<>expected OR
    team.data->'members'->0->>'subject' IS DISTINCT FROM team.owner_id OR
    (SELECT count(DISTINCT m->>'subject') FROM jsonb_array_elements(team.data->'members') m)<>expected OR
    EXISTS(SELECT 1 FROM jsonb_array_elements(team.data->'members') WITH ORDINALITY x(m,n)
      WHERE length(trim(m->>'subject'))=0 OR (m->>'position')::int<>n-1) OR
    (expected=2 AND team.companion_id IS DISTINCT FROM team.data->'members'->1->>'subject') OR
    (expected<>2 AND team.companion_id IS NOT NULL) THEN
   RAISE EXCEPTION 'INVALID_TEAM_MEMBERS' USING ERRCODE='23514';
  END IF;
  IF team.status<>'CANCELLED' AND
    (SELECT array_agg(player_id ORDER BY player_id) FROM registration_members WHERE tournament_id=tid AND team_id=team.id)
     IS DISTINCT FROM (SELECT array_agg(m->>'subject' ORDER BY m->>'subject') FROM jsonb_array_elements(team.data->'members') m)
   THEN RAISE EXCEPTION 'INVALID_TEAM_MEMBERS' USING ERRCODE='23514'; END IF;
  IF team.status IN ('PENDING_PAYMENT','PAYMENT_PENDING','COMPENSATING','CONFIRMED') AND EXISTS(
    SELECT 1 FROM jsonb_array_elements(team.data->'members') m WHERE m->>'consentAt' IS NULL
      OR m->>'consentVersion' NOT IN ('team-registration-v2','team-registration-v3') OR m->>'consentVersion' IS NULL)
   THEN RAISE EXCEPTION 'CONSENT_REQUIRED' USING ERRCODE='23514'; END IF;
 END LOOP;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER registration_teams_members_guard AFTER INSERT OR UPDATE OR DELETE ON registration_teams
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_registration_members_v3();
CREATE CONSTRAINT TRIGGER registration_members_roster_guard AFTER INSERT OR UPDATE OR DELETE ON registration_members
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_registration_members_v3();
CREATE OR REPLACE FUNCTION validate_tournament_bracket() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s jsonb; m jsonb; source_team registration_teams%ROWTYPE; expected_ids jsonb;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.bracket IS NOT NULL THEN RAISE EXCEPTION 'BRACKET_REQUIRES_PUBLICATION' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF OLD.bracket IS NOT NULL AND NEW.bracket IS DISTINCT FROM OLD.bracket THEN
  RAISE EXCEPTION 'IMMUTABLE_BRACKET' USING ERRCODE='23514';
 END IF;
 IF OLD.bracket IS NULL AND NEW.bracket IS NOT NULL THEN
  IF jsonb_typeof(NEW.bracket) IS DISTINCT FROM 'object' OR jsonb_typeof(NEW.bracket->'seeds') IS DISTINCT FROM 'array'
   OR jsonb_typeof(NEW.bracket->'matches') IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'INVALID_BRACKET_ROSTER' USING ERRCODE='23514'; END IF;
  IF NEW.bracket->>'tournamentId' IS DISTINCT FROM NEW.id OR
    NEW.bracket->>'contractVersion' IS DISTINCT FROM NEW.contract_version OR
    (NEW.contract_version='torneos-v3.0.0' AND (NEW.bracket->>'version' IS DISTINCT FROM '3' OR
      NEW.bracket->>'tournamentMode' IS DISTINCT FROM NEW.tournament_mode OR
      (NEW.bracket->>'teamSize')::int IS DISTINCT FROM NEW.team_size)) OR
    (NEW.contract_version<>'torneos-v3.0.0' AND NEW.bracket->>'version' IS DISTINCT FROM '2') OR
    jsonb_array_length(NEW.bracket->'seeds')<>8 OR jsonb_array_length(NEW.bracket->'matches')<>14 OR
    (SELECT count(*) FROM registration_teams WHERE tournament_id=NEW.id AND status='CONFIRMED')<>8 OR
    (SELECT count(DISTINCT player_id) FROM registration_members WHERE tournament_id=NEW.id AND team_id IN
      (SELECT id FROM registration_teams WHERE tournament_id=NEW.id AND status='CONFIRMED'))<>8*NEW.team_size OR
    (SELECT count(DISTINCT v->>'position') FROM jsonb_array_elements(NEW.bracket->'seeds') v)<>8 OR
    (SELECT count(DISTINCT v->>'id') FROM jsonb_array_elements(NEW.bracket->'matches') v)<>14 OR
    (SELECT count(DISTINCT v->>'encounterId') FROM jsonb_array_elements(NEW.bracket->'matches') v)<>14
   THEN RAISE EXCEPTION 'INVALID_BRACKET_ROSTER' USING ERRCODE='23514'; END IF;
  FOR s IN SELECT value FROM jsonb_array_elements(NEW.bracket->'seeds') LOOP
   SELECT * INTO source_team FROM registration_teams WHERE tournament_id=NEW.id AND id=s->>'teamId'
     AND status='CONFIRMED' AND slot=(s->>'position')::int;
   SELECT jsonb_agg(v->'subject' ORDER BY (v->>'position')::int) INTO expected_ids
     FROM jsonb_array_elements(source_team.data->'members') v;
   IF source_team.id IS NULL OR jsonb_array_length(s->'memberIds')<>NEW.team_size OR s->'memberIds' IS DISTINCT FROM expected_ids OR
    s->>'name' IS DISTINCT FROM source_team.data->>'name' OR s->'avatar' IS DISTINCT FROM source_team.data->'avatar' OR
    source_team.data->'entryReceipt' IS NULL OR source_team.data->'entryReceipt'='null'::jsonb OR EXISTS(
     SELECT 1 FROM jsonb_array_elements(source_team.data->'members') v WHERE v->>'consentAt' IS NULL OR
       v->>'consentVersion' NOT IN ('team-registration-v2','team-registration-v3') OR v->>'consentVersion' IS NULL)
    THEN RAISE EXCEPTION 'INVALID_BRACKET_ROSTER' USING ERRCODE='23514'; END IF;
  END LOOP;
  FOR m IN SELECT value FROM jsonb_array_elements(NEW.bracket->'matches') LOOP
   IF m->>'id' IS NULL OR m->>'id' NOT IN ('E1','E2','E3','E4','E5','E6','E7','E8','E9','E10','E11','E12','E13','Final') OR
     length(trim(COALESCE(m->>'encounterId',''))) = 0 OR
     (NEW.contract_version<>'torneos-v3.0.0' AND m->>'encounterId' IS DISTINCT FROM NEW.id||':'||(m->>'id')) OR
     EXISTS(SELECT 1 FROM tournament_encounters WHERE tournament_id=NEW.id AND encounter_id=m->>'encounterId')
    THEN RAISE EXCEPTION 'ENCOUNTER_IDENTITY_CONFLICT' USING ERRCODE='23514'; END IF;
  END LOOP;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION materialize_tournament_bracket() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m jsonb; registered jsonb; side_id jsonb; metadata jsonb;
BEGIN
 IF OLD.bracket IS NULL AND NEW.bracket IS NOT NULL THEN
  FOR m IN SELECT value FROM jsonb_array_elements(NEW.bracket->'matches') LOOP
   registered:='[]'::jsonb;
   FOR side_id IN SELECT value FROM jsonb_array_elements(m->'teamIds') LOOP
    registered:=registered||jsonb_build_array((SELECT jsonb_build_object('teamId',s->>'teamId','name',s->>'name',
      'avatar',s->'avatar','memberIds',s->'memberIds') FROM jsonb_array_elements(NEW.bracket->'seeds') s
      WHERE s->>'teamId'=side_id#>>'{}'));
   END LOOP;
   metadata:=jsonb_build_object('bracketTrack',m->>'track','registeredTeams',registered,'preparationStatus',
     CASE WHEN m->>'status'='TEAMS_RESOLVED' THEN 'TEAMS_RESOLVED' ELSE 'WAITING_TEAMS' END,'engineLastSeq',null,'syncedAt',null);
   IF NEW.contract_version='torneos-v3.0.0' THEN metadata:=metadata||jsonb_build_object('tournamentMode',NEW.tournament_mode,'teamSize',NEW.team_size); END IF;
   INSERT INTO tournament_encounters(tournament_id,encounter_id,round,bracket_label,teams,status,bracket_metadata)
     VALUES(NEW.id,m->>'encounterId',(m->>'round')::int,m->>'id','[]'::jsonb,'WAITING_PARTICIPANTS',metadata);
  END LOOP;
 END IF;
 RETURN NEW;
END $$;
`,
      )
      .execute(db)
    await lifecycleUp(db)
  },
  down: () =>
    Promise.reject(new Error('006 es forward-only: conservar roster, resultados y recibos.')),
}
