-- MusicBrainz and AcousticBrainz enrichment is gone, and so is everything
-- db/sql/post once built on its tables. Those views and functions live in the
-- `spotidata` schema, which drizzle does not manage, so they are dropped here,
-- once, ahead of the migration that drops the tables: Postgres refuses to drop
-- a table a view still reads. `spotidata.analyse_candidates` stays — it is the
-- analysis chain's, and 090_analysis.sql recreates it.
DROP VIEW IF EXISTS spotidata.enrichment_coverage;
--> statement-breakpoint
DROP VIEW IF EXISTS spotidata.enrich_recording_candidates;
--> statement-breakpoint
DROP VIEW IF EXISTS spotidata.enrich_artist_candidates;
--> statement-breakpoint
DROP VIEW IF EXISTS spotidata.enrich_album_candidates;
--> statement-breakpoint
DROP VIEW IF EXISTS spotidata.track_genres;
--> statement-breakpoint
DROP VIEW IF EXISTS spotidata.track_enrichment;
--> statement-breakpoint
DROP VIEW IF EXISTS spotidata.artist_enrichment;
--> statement-breakpoint
DROP VIEW IF EXISTS spotidata.album_enrichment;
--> statement-breakpoint
DROP FUNCTION IF EXISTS spotidata.match_artists_by_credit();
--> statement-breakpoint
DROP FUNCTION IF EXISTS spotidata.mb_genre_list(text, text);
--> statement-breakpoint
DROP FUNCTION IF EXISTS spotidata.norm_name(text);
--> statement-breakpoint
DELETE FROM external_limiters WHERE service IN ('musicbrainz', 'acousticbrainz');
--> statement-breakpoint
-- The analysis ran only while both the enrichment master switch and its own
-- stage were on; its new switch keeps whatever that added up to.
INSERT INTO settings (key, value)
SELECT 'analysis.enabled', to_jsonb(bool_and(value = 'true'::jsonb))
  FROM settings
 WHERE key IN ('enrich.enabled', 'enrich.rbxport')
HAVING count(*) > 0
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
DELETE FROM settings WHERE key LIKE 'enrich.%';
