import { sql, type Kysely } from 'kysely'
/** Ampliación aditiva: acepta resolución Tournament sin falsificar el archivo Combat. */
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await sql`CREATE OR REPLACE FUNCTION validate_tournament_lifecycle_v2() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE b jsonb; r jsonb; m jsonb; e record; terminal jsonb; team jsonb; seed jsonb;
      champ jsonb; cfg jsonb; d jsonb; final_result jsonb; a jsonb; l jsonb; previous jsonb;
      absence jsonb; hero text; expected_count int; expected_winner text; total numeric;
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Results and receipts are immutable' USING ERRCODE='23514'; END IF;
      SELECT bracket INTO b FROM tournaments WHERE id=NEW.tournament_id;
      IF b IS NULL THEN RAISE EXCEPTION 'Published bracket required' USING ERRCODE='23514'; END IF;
      IF TG_OP='UPDATE' THEN
        IF OLD.tournament_id<>NEW.tournament_id OR
          jsonb_array_length(NEW.data->'results')<jsonb_array_length(OLD.data->'results') OR EXISTS(
          SELECT 1 FROM jsonb_array_elements(OLD.data->'results') WITH ORDINALITY AS x(v,n)
            WHERE v IS DISTINCT FROM NEW.data->'results'->(n::int-1)) OR
          (OLD.data->'champion'<>'null'::jsonb AND OLD.data->'champion' IS DISTINCT FROM NEW.data->'champion') OR
          (OLD.data->'configuration'<>'null'::jsonb AND OLD.data->'configuration' IS DISTINCT FROM NEW.data->'configuration') OR
          (OLD.data->'delivery'<>'null'::jsonb AND NEW.data->'delivery'='null'::jsonb) THEN
          RAISE EXCEPTION 'Confirmed result, champion and configuration are immutable' USING ERRCODE='23514';
        END IF;
        IF OLD.data->'delivery'<>'null'::jsonb THEN
          IF OLD.data->'delivery'->'requestedAt' IS DISTINCT FROM NEW.data->'delivery'->'requestedAt' OR
            OLD.data->'delivery'->'requestedBy' IS DISTINCT FROM NEW.data->'delivery'->'requestedBy' OR
            jsonb_array_length(OLD.data->'delivery'->'lines')<>jsonb_array_length(NEW.data->'delivery'->'lines') THEN
            RAISE EXCEPTION 'Prize intent is immutable' USING ERRCODE='23514'; END IF;
          FOR l IN SELECT value FROM jsonb_array_elements(OLD.data->'delivery'->'lines') LOOP
            SELECT x INTO previous FROM jsonb_array_elements(NEW.data->'delivery'->'lines') x WHERE x->>'operationId'=l->>'operationId';
            IF previous IS NULL OR (l-ARRAY['status','receiptId','deliveredAt','lastError','responsible','heroId']) IS DISTINCT FROM
              (previous-ARRAY['status','receiptId','deliveredAt','lastError','responsible','heroId']) OR
              (l->>'heroId' IS NOT NULL AND l->'heroId' IS DISTINCT FROM previous->'heroId') OR (l->>'status'='DELIVERED' AND l IS DISTINCT FROM previous) THEN
              RAISE EXCEPTION 'Prize right and confirmed receipt are immutable' USING ERRCODE='23514'; END IF;
          END LOOP;
        END IF;
      END IF;
      IF (SELECT count(DISTINCT x->>'encounterId') FROM jsonb_array_elements(NEW.data->'results') x)<>
        jsonb_array_length(NEW.data->'results') THEN RAISE EXCEPTION 'One result per encounter' USING ERRCODE='23514'; END IF;
      FOR r IN SELECT value FROM jsonb_array_elements(NEW.data->'results') LOOP
        SELECT x INTO m FROM jsonb_array_elements(b->'matches') x WHERE x->>'encounterId'=r->>'encounterId';
        SELECT * INTO e FROM tournament_encounters WHERE tournament_id=NEW.tournament_id AND encounter_id=r->>'encounterId';
        SELECT payload INTO terminal FROM tournament_combat_events WHERE tournament_id=NEW.tournament_id
          AND encounter_id=r->>'encounterId' AND seq=e.last_synced_seq;
        expected_winner:=NULL;
        IF e.result->>'outcome'='WIN' THEN SELECT x->>'teamId' INTO expected_winner FROM jsonb_array_elements(e.teams) x
          WHERE x->>'teamLabel'=e.result->>'winnerTeamLabel'; END IF;
        IF r->>'source'='TOURNAMENT' THEN
          SELECT data INTO absence FROM tournament_resolutions WHERE tournament_id=NEW.tournament_id AND encounter_id=r->>'encounterId'
            AND resolution_id=r->>'resolutionId';
          IF NOT COALESCE(absence IS NOT NULL AND r->'tournamentResolution'=absence AND r->>'roomId' IS NULL AND r->'result'='null'::jsonb
            AND e.combat_room_id IS NULL AND m->>'id'=r->>'matchId' AND r->>'winnerTeamId'=absence->>'winnerTeamId'
            AND r->>'loserTeamId'=absence->>'loserTeamId' AND r->'teamIds'=absence->'teamIds'
            AND (r->>'confirmedAt')::timestamptz=(absence->>'resolvedAt')::timestamptz
            AND r->'teamIds'=jsonb_build_array(tournament_progress_source(b,NEW.data,m->'sources'->0),
              tournament_progress_source(b,NEW.data,m->'sources'->1)),false) THEN
              RAISE EXCEPTION 'Result requires an authoritative Tournament resolution' USING ERRCODE='23514';
          END IF;
        ELSE
        IF NOT COALESCE(m->>'id'=r->>'matchId' AND e.bracket_label=r->>'matchId' AND e.status='FINISHED'
          AND e.combat_room_id=r->>'roomId' AND e.started_at IS NOT NULL AND e.closed_at IS NOT NULL
          AND e.last_synced_seq>0 AND e.log_complete AND
          e.bracket_metadata->'engineLastSeq'=to_jsonb(e.last_synced_seq) AND e.result=r->'result'
          AND e.result->>'outcome' IN ('WIN','NO_WINNER') AND e.result->>'reason' IN ('ELIMINATION','DISCONNECTION','TIME_LIMIT')
          AND e.closed_at=(e.result->>'finishedAt')::timestamptz AND e.started_at<=e.closed_at
          AND terminal->>'type'='battleFinished' AND terminal->>'roomId'=e.combat_room_id
          AND terminal->'result'=e.result AND (terminal->>'seq')::int=e.last_synced_seq
          AND (terminal->>'occurredAt')::timestamptz=e.closed_at AND
          r->'teamIds'=jsonb_build_array(tournament_progress_source(b,NEW.data,m->'sources'->0),
            tournament_progress_source(b,NEW.data,m->'sources'->1)) AND jsonb_array_length(e.teams)=2
          AND (SELECT count(DISTINCT x->>'teamId') FROM jsonb_array_elements(e.teams) x)=2
          AND (SELECT count(DISTINCT x->>'teamLabel') FROM jsonb_array_elements(e.teams) x)=2
          AND (SELECT count(DISTINCT p->>'heroId') FROM jsonb_array_elements(e.teams) t,
            LATERAL jsonb_array_elements(t->'participants') p)=2*COALESCE((b->>'teamSize')::int,2)
          AND r->>'winnerTeamId' IS NOT DISTINCT FROM expected_winner
          AND (CASE WHEN expected_winner IS NULL THEN r->>'loserTeamId' IS NULL AND e.result->>'outcome'='NO_WINNER'
            AND e.result->>'winnerTeamLabel' IS NULL ELSE r->>'loserTeamId'=
            (SELECT x#>>'{}' FROM jsonb_array_elements(r->'teamIds') x WHERE x#>>'{}'<>expected_winner) END)
          AND (SELECT count(*) FROM tournament_combat_events WHERE tournament_id=NEW.tournament_id
            AND encounter_id=r->>'encounterId' AND seq BETWEEN 1 AND e.last_synced_seq)=e.last_synced_seq
          AND NOT EXISTS (SELECT 1 FROM tournament_combat_events WHERE tournament_id=NEW.tournament_id AND
            encounter_id=r->>'encounterId' AND seq<=e.last_synced_seq AND (payload->>'roomId' IS DISTINCT FROM e.combat_room_id
              OR payload->>'type' IS DISTINCT FROM type OR payload->'seq' IS DISTINCT FROM to_jsonb(seq)
              OR (payload->>'occurredAt')::timestamptz IS DISTINCT FROM occurred_at)), false) THEN
          RAISE EXCEPTION 'Result requires the complete official HU83 archive' USING ERRCODE='23514'; END IF;
        FOR team IN SELECT value FROM jsonb_array_elements(e.teams) LOOP
          SELECT x INTO seed FROM jsonb_array_elements(b->'seeds') x WHERE x->>'teamId'=team->>'teamId';
          IF NOT COALESCE(r->'teamIds' ? (team->>'teamId') AND jsonb_array_length(team->'participants')=COALESCE((b->>'teamSize')::int,2)
            AND (SELECT jsonb_agg(x->'playerId' ORDER BY x->>'playerId') FROM jsonb_array_elements(team->'participants') x)=
              (SELECT jsonb_agg(x ORDER BY x#>>'{}') FROM jsonb_array_elements(seed->'memberIds') x)
            AND (SELECT count(DISTINCT x->>'heroId') FROM jsonb_array_elements(team->'participants') x)=COALESCE((b->>'teamSize')::int,2)
            AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(team->'participants') x WHERE length(trim(x->>'heroId'))=0),false) THEN
            RAISE EXCEPTION 'Result roster must match bracket members' USING ERRCODE='23514'; END IF;
        END LOOP;
        END IF;
      END LOOP;
      champ:=NEW.data->'champion'; cfg:=NEW.data->'configuration'; d:=NEW.data->'delivery';
      SELECT x INTO final_result FROM jsonb_array_elements(NEW.data->'results') x WHERE x->>'matchId'='Final';
      IF champ<>'null'::jsonb THEN
        SELECT * INTO e FROM tournament_encounters WHERE tournament_id=NEW.tournament_id AND encounter_id=final_result->>'encounterId';
        SELECT x INTO seed FROM jsonb_array_elements(b->'seeds') x WHERE x->>'teamId'=champ->>'teamId';
        IF NOT COALESCE(champ->>'teamId'=final_result->>'winnerTeamId' AND champ->>'teamName'=seed->>'name'
          AND champ->'memberIds'=seed->'memberIds' AND champ->>'finalEncounterId'=final_result->>'encounterId'
          AND champ->>'finalRoomId' IS NOT DISTINCT FROM final_result->>'roomId' AND champ->'heroes'=
            CASE WHEN final_result->>'source'='TOURNAMENT' THEN '[]'::jsonb ELSE
              (SELECT x->'participants' FROM jsonb_array_elements(e.teams) x WHERE x->>'teamId'=champ->>'teamId') END
          AND jsonb_array_length(NEW.data->'results')=jsonb_array_length(b->'matches') AND NOT EXISTS(
            SELECT 1 FROM jsonb_array_elements(NEW.data->'results') x WHERE x->>'winnerTeamId' IS NULL), false) THEN
          RAISE EXCEPTION 'Champion requires final and dependencies' USING ERRCODE='23514'; END IF;
      ELSIF final_result->>'winnerTeamId' IS NOT NULL THEN RAISE EXCEPTION 'Final requires champion projection' USING ERRCODE='23514'; END IF;
      IF cfg<>'null'::jsonb THEN
        IF NOT COALESCE(length(trim(cfg->>'operationId'))>0 AND length(trim(cfg->>'approvedBy'))>0
          AND cfg->>'approvedAt' IS NOT NULL AND jsonb_array_length(cfg->'allocations')=COALESCE((b->>'teamSize')::int,2) AND
          (SELECT count(DISTINCT x->>'memberIndex') FROM jsonb_array_elements(cfg->'allocations') x)=COALESCE((b->>'teamSize')::int,2) AND
          EXISTS(SELECT 1 FROM jsonb_array_elements(cfg->'allocations') x WHERE x->>'epicProductId' IS NOT NULL),false) THEN
          RAISE EXCEPTION 'Explicit prize configuration required' USING ERRCODE='23514'; END IF;
        total:=0;
        FOR a IN SELECT value FROM jsonb_array_elements(cfg->'allocations') LOOP
          IF NOT COALESCE((a->>'memberIndex')::int BETWEEN 0 AND COALESCE((b->>'teamSize')::int,2)-1 AND jsonb_typeof(a->'credits')='string' AND
            a->>'credits' ~ '^[1-9][0-9]{0,15}$' AND (a->>'credits')::numeric<=9007199254740991 AND
            a ? 'epicProductId' AND (a->>'epicProductId' IS NULL OR length(trim(a->>'epicProductId'))>0),false) THEN
            RAISE EXCEPTION 'Invalid prize allocation' USING ERRCODE='23514'; END IF;
          total:=total+(a->>'credits')::numeric;
        END LOOP;
        IF total>9007199254740991 THEN RAISE EXCEPTION 'Prize exceeds exact range' USING ERRCODE='23514'; END IF;
      END IF;
      IF d<>'null'::jsonb THEN
        IF champ='null'::jsonb OR cfg='null'::jsonb THEN RAISE EXCEPTION 'Champion and configuration required' USING ERRCODE='23514'; END IF;
        SELECT COALESCE((b->>'teamSize')::int,2)+count(*) INTO expected_count FROM jsonb_array_elements(cfg->'allocations') x WHERE x->>'epicProductId' IS NOT NULL;
        IF jsonb_array_length(d->'lines')<>expected_count OR
          (SELECT count(DISTINCT x->>'operationId') FROM jsonb_array_elements(d->'lines') x)<>expected_count THEN
          RAISE EXCEPTION 'All durable rights required' USING ERRCODE='23514'; END IF;
        FOR l IN SELECT value FROM jsonb_array_elements(d->'lines') LOOP
          SELECT x INTO a FROM jsonb_array_elements(cfg->'allocations') x WHERE champ->'memberIds'->>((x->>'memberIndex')::int)=l->>'playerId';
          SELECT x->>'heroId' INTO hero FROM jsonb_array_elements(champ->'heroes') x WHERE x->>'playerId'=l->>'playerId';
          IF NOT COALESCE(a IS NOT NULL AND (l->>'heroId'=hero OR (champ->>'finalRoomId' IS NULL AND (l->>'status'='PENDING' OR l->>'heroId' IS NOT NULL))) AND l->>'tournamentId'=NEW.tournament_id
            AND l->>'championTeamId'=champ->>'teamId' AND l->>'finalEncounterId'=champ->>'finalEncounterId'
            AND l->>'finalRoomId' IS NOT DISTINCT FROM champ->>'finalRoomId' AND l->>'operationId'=
              'tournament:'||NEW.tournament_id||':prize:'||(a->>'memberIndex')||':'||(l->>'kind') AND
            ((l->>'kind'='CREDITS' AND l->'amount'=a->'credits' AND l->>'productId' IS NULL) OR
              (l->>'kind'='EPIC' AND a->>'epicProductId' IS NOT NULL AND l->'productId'=a->'epicProductId' AND l->>'amount' IS NULL)) AND
            ((l->>'status'='PENDING' AND l->>'receiptId' IS NULL AND l->>'deliveredAt' IS NULL) OR
              (l->>'status'='DELIVERED' AND length(trim(l->>'receiptId'))>0 AND l->>'deliveredAt' IS NOT NULL AND l->>'lastError' IS NULL)),false) THEN
            RAISE EXCEPTION 'Right must match configuration and final roster' USING ERRCODE='23514'; END IF;
        END LOOP;
      END IF;
      RETURN NEW;
    END $$`.execute(db)
}
