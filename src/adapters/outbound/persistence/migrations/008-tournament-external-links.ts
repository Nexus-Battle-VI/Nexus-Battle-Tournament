import { sql, type Kysely } from 'kysely'
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await sql`CREATE FUNCTION tournament_public_link(value text, archive boolean) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE AS $$
    DECLARE yt text := '^https://(www[.]|m[.])?youtube[.]com/';
      channel text := '(channel/[A-Za-z0-9_-]+|@[A-Za-z0-9_.-]+|(c|user)/[A-Za-z0-9_.-]+)';
      playback text := '[0-9]+([hms][0-9]+)*[hms]?';
    BEGIN
      IF value IS NULL THEN RETURN true; END IF;
      IF length(value)>2048 THEN RETURN false; END IF;
      IF archive THEN RETURN value ~ (yt || channel || '(/(videos|streams|live))?/?$'); END IF;
      RETURN value ~ (yt || channel || '(/live)?/?$')
        OR value ~ (yt || 'watch[?]v=[A-Za-z0-9_-]{11}(&t=' || playback || ')?$')
        OR value ~ (yt || 'live/[A-Za-z0-9_-]{11}/?([?]t=' || playback || ')?$')
        OR value ~ ('^https://youtu[.]be/[A-Za-z0-9_-]{11}/?([?]t=' || playback || ')?$')
        OR (value ~ '^https://(www[.])?twitch[.]tv/([A-Za-z0-9_]{1,25}|videos/[0-9]+)/?$'
          AND lower(value) !~ '/(directory|settings|login|signup|downloads|search|subscriptions|inventory)/?$');
    END $$`.execute(db)
  await sql`CREATE TABLE tournament_external_links (
    tournament_id text PRIMARY KEY REFERENCES tournaments(id), live_url text, youtube_archive_url text,
    revision bigint NOT NULL CHECK (revision>=1 AND revision<9007199254740991), updated_at timestamptz NOT NULL,
    CHECK (tournament_public_link(live_url,false)), CHECK (tournament_public_link(youtube_archive_url,true))
  )`.execute(db)
  await sql`CREATE FUNCTION validate_tournament_external_links() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE changed boolean; expected bigint;
    BEGIN
      IF TG_OP='INSERT' THEN
        IF NEW.revision<>1 THEN RAISE EXCEPTION 'First publication has revision one' USING ERRCODE='23514'; END IF;
      ELSE
        changed:=OLD.live_url IS DISTINCT FROM NEW.live_url OR OLD.youtube_archive_url IS DISTINCT FROM NEW.youtube_archive_url;
        expected:=OLD.revision; IF changed THEN expected:=expected+1; END IF;
        IF NEW.tournament_id<>OLD.tournament_id OR NEW.revision<>expected OR NEW.updated_at<OLD.updated_at
          OR (NOT changed AND NEW.updated_at IS DISTINCT FROM OLD.updated_at) THEN
          RAISE EXCEPTION 'Link revisions must follow publications' USING ERRCODE='23514';
        END IF;
      END IF;
      RETURN NEW;
    END $$`.execute(db)
  await sql`CREATE TRIGGER external_links_validation BEFORE INSERT OR UPDATE ON tournament_external_links
    FOR EACH ROW EXECUTE FUNCTION validate_tournament_external_links()`.execute(db)
}
export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('tournament_external_links').execute()
  await sql`DROP FUNCTION validate_tournament_external_links()`.execute(db)
  await sql`DROP FUNCTION tournament_public_link(text,boolean)`.execute(db)
}
