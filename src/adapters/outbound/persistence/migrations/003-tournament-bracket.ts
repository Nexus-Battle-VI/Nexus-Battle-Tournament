import { sql, type Migration } from 'kysely'

export const migration: Migration = {
  up: async (db) => {
    await sql
      .raw(
        `
ALTER TABLE tournaments ADD COLUMN bracket jsonb;
ALTER TABLE tournament_encounters ADD COLUMN bracket_metadata jsonb;
CREATE FUNCTION validate_tournament_bracket() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s jsonb; m jsonb; source_team registration_teams%ROWTYPE;
BEGIN
 IF TG_OP = 'INSERT' THEN
  IF NEW.bracket IS NOT NULL THEN RAISE EXCEPTION 'BRACKET_REQUIRES_PUBLICATION' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF OLD.bracket IS NOT NULL AND NEW.bracket IS DISTINCT FROM OLD.bracket THEN
  RAISE EXCEPTION 'IMMUTABLE_BRACKET' USING ERRCODE='23514';
 END IF;
 IF OLD.bracket IS NULL AND NEW.bracket IS NOT NULL THEN
  IF jsonb_typeof(NEW.bracket) IS DISTINCT FROM 'object' OR jsonb_typeof(NEW.bracket->'seeds') IS DISTINCT FROM 'array' OR jsonb_typeof(NEW.bracket->'matches') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'INVALID_BRACKET_ROSTER' USING ERRCODE='23514'; END IF;
  IF NEW.bracket->>'tournamentId' IS DISTINCT FROM NEW.id OR NEW.bracket->>'version' IS DISTINCT FROM '2'
    OR NEW.bracket->>'contractVersion' IS DISTINCT FROM 'torneos-hu77-84-78-hu83-v2.0.0'
    OR jsonb_array_length(NEW.bracket->'seeds') <> 8
    OR jsonb_array_length(NEW.bracket->'matches') <> 14
    OR (SELECT count(*) FROM registration_teams WHERE tournament_id=NEW.id AND status='CONFIRMED') <> 8
    OR (SELECT count(DISTINCT player_id) FROM registration_members WHERE tournament_id=NEW.id
      AND team_id IN (SELECT id FROM registration_teams WHERE tournament_id=NEW.id AND status='CONFIRMED')) <> 16
    OR (SELECT count(DISTINCT v->>'position') FROM jsonb_array_elements(NEW.bracket->'seeds') v) <> 8
    OR (SELECT count(DISTINCT v->>'id') FROM jsonb_array_elements(NEW.bracket->'matches') v) <> 14
  THEN RAISE EXCEPTION 'INVALID_BRACKET_ROSTER' USING ERRCODE='23514'; END IF;
  FOR s IN SELECT value FROM jsonb_array_elements(NEW.bracket->'seeds') LOOP
   SELECT * INTO source_team FROM registration_teams WHERE tournament_id=NEW.id
    AND id=s->>'teamId' AND status='CONFIRMED' AND slot=(s->>'position')::integer;
   IF NOT FOUND OR s->'memberIds' IS DISTINCT FROM jsonb_build_array(source_team.owner_id,source_team.companion_id)
     OR s->>'name' IS DISTINCT FROM source_team.data->>'name' OR s->'avatar' IS DISTINCT FROM source_team.data->'avatar'
     OR source_team.data->>'consentVersion' IS DISTINCT FROM 'team-registration-v2'
     OR source_team.data->>'ownerConsentVersion' IS DISTINCT FROM 'team-registration-v2'
     OR source_team.data->>'ownerConsentAt' IS NULL OR source_team.data->>'consentAt' IS NULL
     OR NOT EXISTS(SELECT 1 FROM registration_members WHERE tournament_id=NEW.id AND team_id=source_team.id AND player_id=source_team.owner_id)
     OR NOT EXISTS(SELECT 1 FROM registration_members WHERE tournament_id=NEW.id AND team_id=source_team.id AND player_id=source_team.companion_id)
     OR source_team.data->'entryReceipt' IS NULL OR source_team.data->'entryReceipt' = 'null'::jsonb
   THEN RAISE EXCEPTION 'INVALID_BRACKET_ROSTER' USING ERRCODE='23514'; END IF;
  END LOOP;
  FOR m IN SELECT value FROM jsonb_array_elements(NEW.bracket->'matches') LOOP
   IF m->>'encounterId' IS DISTINCT FROM NEW.id || ':' || (m->>'id') OR m->>'id' IS NULL
    OR m->>'id' NOT IN ('E1','E2','E3','E4','E5','E6','E7','E8','E9','E10','E11','E12','E13','Final')
    OR EXISTS(SELECT 1 FROM tournament_encounters WHERE tournament_id=NEW.id AND encounter_id=m->>'encounterId')
   THEN RAISE EXCEPTION 'ENCOUNTER_IDENTITY_CONFLICT' USING ERRCODE='23514'; END IF;
  END LOOP;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER tournaments_bracket_guard BEFORE INSERT OR UPDATE OF bracket ON tournaments
 FOR EACH ROW EXECUTE FUNCTION validate_tournament_bracket();
CREATE FUNCTION materialize_tournament_bracket() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m jsonb; registered jsonb; side_id jsonb;
BEGIN
 IF OLD.bracket IS NULL AND NEW.bracket IS NOT NULL THEN
  FOR m IN SELECT value FROM jsonb_array_elements(NEW.bracket->'matches') LOOP
   registered := '[]'::jsonb;
   FOR side_id IN SELECT value FROM jsonb_array_elements(m->'teamIds') LOOP
    registered := registered || jsonb_build_array(
     (SELECT jsonb_build_object('teamId',s->>'teamId','name',s->>'name','avatar',s->'avatar','memberIds',s->'memberIds')
      FROM jsonb_array_elements(NEW.bracket->'seeds') s WHERE s->>'teamId'=side_id #>> '{}'));
   END LOOP;
   INSERT INTO tournament_encounters(tournament_id,encounter_id,round,bracket_label,teams,status,bracket_metadata)
    VALUES (NEW.id,m->>'encounterId',(m->>'round')::integer,m->>'id','[]'::jsonb,'WAITING_PARTICIPANTS',
     jsonb_build_object('bracketTrack',m->>'track','registeredTeams',registered,
      'preparationStatus',CASE WHEN m->>'status'='TEAMS_RESOLVED' THEN 'TEAMS_RESOLVED' ELSE 'WAITING_TEAMS' END,
      'engineLastSeq',null,'syncedAt',null));
  END LOOP;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER tournaments_bracket_materialize AFTER UPDATE OF bracket ON tournaments
 FOR EACH ROW EXECUTE FUNCTION materialize_tournament_bracket();
`,
      )
      .execute(db)
  },
  down: async (db) => {
    await sql
      .raw(
        `
DROP TRIGGER tournaments_bracket_materialize ON tournaments; DROP TRIGGER tournaments_bracket_guard ON tournaments; DROP FUNCTION materialize_tournament_bracket(); DROP FUNCTION validate_tournament_bracket(); ALTER TABLE tournament_encounters DROP COLUMN bracket_metadata; ALTER TABLE tournaments DROP COLUMN bracket;
`,
      )
      .execute(db)
  },
}
