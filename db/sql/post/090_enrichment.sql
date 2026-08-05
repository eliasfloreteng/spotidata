-- MusicBrainz / AcousticBrainz enrichment: the candidate sets the crawler
-- walks, the free (request-less) artist match, and the views that read the
-- result back out.
--
-- Everything here lives in the `spotidata` schema: drizzle-kit is pinned to
-- `public` and would plan a DROP for anything it finds there that it did not
-- generate. The views are granted to the MCP role at the bottom, since
-- 070_mcp_role.sql runs before this file and cannot see them.

-- Artist names differ across catalogs mostly in punctuation and diacritics
-- ("Sigur Rós" / "Sigur Ros", "P!nk" / "Pink"). Same idea as norm_title, but
-- without the parenthetical stripping — "(Sandy) Alex G" is a name, not a
-- qualifier.
CREATE OR REPLACE FUNCTION spotidata.norm_name(p text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT btrim(regexp_replace(lower(unaccent(coalesce(p, ''))), '[^a-z0-9]+', ' ', 'g'))
$$;

-- ------------------------------------------------------------- candidates
--
-- What "worth enriching" means, in one place. A crawl at one request per
-- second cannot cover 30k albums in an evening, so the candidate sets are
-- restricted to music that is in the library or has actually been played, and
-- every one of them carries a play count that orders the queue: the tracks you
-- listen to get their BPM first.

DROP VIEW IF EXISTS spotidata.enrichment_coverage CASCADE;
DROP VIEW IF EXISTS spotidata.enrich_recording_candidates CASCADE;
DROP VIEW IF EXISTS spotidata.enrich_artist_candidates CASCADE;
DROP VIEW IF EXISTS spotidata.enrich_album_candidates CASCADE;

CREATE VIEW spotidata.enrich_recording_candidates AS
  SELECT ct.id AS canonical_track_id,
         ct.isrc,
         coalesce(ps.plays, 0) AS plays
    FROM canonical_tracks ct
    LEFT JOIN canonical_play_stats ps ON ps.canonical_track_id = ct.id
   WHERE ct.isrc IS NOT NULL
     AND (coalesce(ps.plays, 0) > 0
          OR EXISTS (SELECT 1 FROM library_canonical lc
                      WHERE lc.canonical_track_id = ct.id));

CREATE VIEW spotidata.enrich_artist_candidates AS
  SELECT cta.artist_id,
         sum(coalesce(ps.plays, 0))::int AS plays
    FROM canonical_track_artists cta
    LEFT JOIN canonical_play_stats ps ON ps.canonical_track_id = cta.canonical_track_id
   WHERE coalesce(ps.plays, 0) > 0
      OR EXISTS (SELECT 1 FROM library_canonical lc
                  WHERE lc.canonical_track_id = cta.canonical_track_id)
   GROUP BY cta.artist_id;

CREATE VIEW spotidata.enrich_album_candidates AS
  SELECT ct.primary_album_id AS album_id,
         sum(coalesce(ps.plays, 0))::int AS plays
    FROM canonical_tracks ct
    LEFT JOIN canonical_play_stats ps ON ps.canonical_track_id = ct.id
   WHERE ct.primary_album_id IS NOT NULL
     AND (coalesce(ps.plays, 0) > 0
          OR EXISTS (SELECT 1 FROM library_canonical lc
                      WHERE lc.canonical_track_id = ct.id))
   GROUP BY ct.primary_album_id;

-- ---------------------------------------------------- request-free matching
--
-- Every ISRC lookup returns the recording's full artist credit, MBIDs and all.
-- So by the time the recording stage has run, most artists are already
-- identified — for free — and only need their name to agree with ours. Doing
-- this before the URL-relation stage removes thousands of requests, which at
-- 1/s is the difference between hours.
--
-- `support` is how many of our recordings back the pairing; ties break on the
-- MBID so the result is deterministic.
CREATE OR REPLACE FUNCTION spotidata.match_artists_by_credit()
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  n integer;
BEGIN
  WITH pairs AS (
    SELECT cta.artist_id, mra.artist_mbid, count(*) AS support
      FROM canonical_tracks ct
      JOIN isrc_recordings ir
        ON ir.isrc = ct.isrc AND ir.recording_mbid IS NOT NULL
      JOIN mb_recording_artists mra ON mra.recording_mbid = ir.recording_mbid
      JOIN canonical_track_artists cta ON cta.canonical_track_id = ct.id
      JOIN artists a ON a.id = cta.artist_id
      JOIN mb_artists ma ON ma.mbid = mra.artist_mbid
     WHERE NOT EXISTS (SELECT 1 FROM artist_musicbrainz am WHERE am.artist_id = cta.artist_id)
       AND (spotidata.norm_name(a.name) = spotidata.norm_name(mra.credit_name)
            OR spotidata.norm_name(a.name) = spotidata.norm_name(ma.name))
     GROUP BY cta.artist_id, mra.artist_mbid
  ), best AS (
    SELECT DISTINCT ON (artist_id) artist_id, artist_mbid
      FROM pairs
     ORDER BY artist_id, support DESC, artist_mbid
  )
  INSERT INTO artist_musicbrainz (artist_id, mbid, status, source)
  SELECT artist_id, artist_mbid, 'matched', 'credit' FROM best
  ON CONFLICT (artist_id) DO NOTHING;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- ------------------------------------------------------------- read models

DROP VIEW IF EXISTS spotidata.track_enrichment CASCADE;
DROP VIEW IF EXISTS spotidata.artist_enrichment CASCADE;
DROP VIEW IF EXISTS spotidata.album_enrichment CASCADE;

-- Genres, per entity, best-voted first. A tag counts as a genre when
-- MusicBrainz served it as one *or* when it appears in the curated genre list
-- — the second case catches entities we only ever fetched tags for.
CREATE OR REPLACE FUNCTION spotidata.mb_genre_list(p_type text, p_mbid text)
RETURNS text[] LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT array_agg(t.tag ORDER BY t.count DESC, t.tag)
    FROM mb_tags t
   WHERE t.entity_type = p_type
     AND t.entity_mbid = p_mbid
     AND (t.is_genre OR EXISTS (SELECT 1 FROM mb_genres g WHERE g.name = t.tag))
$$;

CREATE VIEW spotidata.track_enrichment AS
  SELECT ct.id                             AS canonical_track_id,
         ct.isrc,
         ir.recording_mbid,
         ir.status                         AS lookup_status,
         mr.title                          AS mb_title,
         mr.length_ms                      AS mb_length_ms,
         mr.first_release_date_start       AS mb_first_release_date,
         mr.disambiguation                 AS mb_disambiguation,
         spotidata.mb_genre_list('recording', ir.recording_mbid) AS genres,
         af.bpm,
         af.key_key,
         af.key_scale,
         af.key_strength,
         af.danceable,
         af.happy,
         af.sad,
         af.party,
         af.relaxed,
         af.aggressive,
         af.acoustic,
         af.electronic,
         af.instrumental,
         af.bright,
         af.tonal,
         af.average_loudness,
         af.replay_gain,
         af.genre_rosamerica,
         af.mood_mirex
    FROM canonical_tracks ct
    LEFT JOIN isrc_recordings ir ON ir.isrc = ct.isrc
    LEFT JOIN mb_recordings mr   ON mr.mbid = ir.recording_mbid
    LEFT JOIN audio_features af  ON af.recording_mbid = ir.recording_mbid
                                AND af.status = 'ok';

-- Matched rows only: a miss is recorded in `artist_musicbrainz` so it is never
-- asked again, but a row of nothing but NULLs is noise in a read model.
CREATE VIEW spotidata.artist_enrichment AS
  SELECT a.id                   AS artist_id,
         am.mbid,
         am.status              AS lookup_status,
         am.source              AS match_source,
         ma.name                AS mb_name,
         ma.sort_name,
         ma.type,
         ma.gender,
         ma.country,
         ma.area_name,
         ma.begin_area_name,
         ma.begin_date,
         ma.end_date,
         ma.ended,
         ma.disambiguation,
         ma.rating_value,
         ma.rating_votes,
         spotidata.mb_genre_list('artist', am.mbid) AS genres
    FROM artists a
    JOIN artist_musicbrainz am ON am.artist_id = a.id
    JOIN mb_artists ma         ON ma.mbid = am.mbid;

-- Matched rows only, for the same reason as artist_enrichment above.
CREATE VIEW spotidata.album_enrichment AS
  SELECT al.id                  AS album_id,
         amb.release_mbid,
         amb.status             AS lookup_status,
         r.title                AS mb_title,
         r.status               AS release_status,
         r.date                 AS release_date,
         r.country,
         r.barcode,
         r.packaging,
         r.language,
         r.label_name,
         r.catalog_number,
         r.release_group_mbid,
         rg.title               AS release_group_title,
         rg.primary_type,
         rg.secondary_types,
         rg.first_release_date  AS group_first_release_date,
         coalesce(
           spotidata.mb_genre_list('release_group', r.release_group_mbid),
           spotidata.mb_genre_list('release', amb.release_mbid)
         )                      AS genres
    FROM albums al
    JOIN album_musicbrainz amb  ON amb.album_id = al.id
    JOIN mb_releases r          ON r.mbid = amb.release_mbid
    LEFT JOIN mb_release_groups rg ON rg.mbid = r.release_group_mbid;

-- One row per stage, sized against the candidate sets above so the progress
-- bars and the crawler can never disagree about what "done" means.
CREATE VIEW spotidata.enrichment_coverage AS
  SELECT 'recordings' AS stage,
         (SELECT count(*) FROM spotidata.enrich_recording_candidates)::int AS candidates,
         (SELECT count(*) FROM spotidata.enrich_recording_candidates c
            JOIN isrc_recordings ir ON ir.isrc = c.isrc
           WHERE ir.recording_mbid IS NOT NULL)::int AS matched,
         (SELECT count(*) FROM spotidata.enrich_recording_candidates c
            JOIN isrc_recordings ir ON ir.isrc = c.isrc
           WHERE ir.status = 'not_found')::int AS missed
  UNION ALL
  SELECT 'audio',
         (SELECT count(DISTINCT ir.recording_mbid) FROM spotidata.enrich_recording_candidates c
            JOIN isrc_recordings ir ON ir.isrc = c.isrc
           WHERE ir.recording_mbid IS NOT NULL)::int,
         (SELECT count(DISTINCT ir.recording_mbid) FROM spotidata.enrich_recording_candidates c
            JOIN isrc_recordings ir ON ir.isrc = c.isrc
            JOIN audio_features af ON af.recording_mbid = ir.recording_mbid AND af.status = 'ok')::int,
         (SELECT count(DISTINCT ir.recording_mbid) FROM spotidata.enrich_recording_candidates c
            JOIN isrc_recordings ir ON ir.isrc = c.isrc
            JOIN audio_features af ON af.recording_mbid = ir.recording_mbid AND af.status = 'missing')::int
  UNION ALL
  SELECT 'artists',
         (SELECT count(*) FROM spotidata.enrich_artist_candidates)::int,
         (SELECT count(*) FROM spotidata.enrich_artist_candidates c
            JOIN artist_musicbrainz am ON am.artist_id = c.artist_id
            JOIN mb_artists ma ON ma.mbid = am.mbid
           WHERE ma.detail_level = 'full')::int,
         (SELECT count(*) FROM spotidata.enrich_artist_candidates c
            JOIN artist_musicbrainz am ON am.artist_id = c.artist_id
           WHERE am.status = 'not_found')::int
  UNION ALL
  SELECT 'albums',
         (SELECT count(*) FROM spotidata.enrich_album_candidates)::int,
         (SELECT count(*) FROM spotidata.enrich_album_candidates c
            JOIN album_musicbrainz amb ON amb.album_id = c.album_id
           WHERE amb.release_mbid IS NOT NULL)::int,
         (SELECT count(*) FROM spotidata.enrich_album_candidates c
            JOIN album_musicbrainz amb ON amb.album_id = c.album_id
           WHERE amb.status = 'not_found')::int;

-- 070_mcp_role.sql ran before this file, so its blanket grant missed
-- everything above. Enrichment is exactly the sort of thing an analytics
-- client wants ("what key is my library in?"), so hand it over explicitly.
GRANT SELECT ON ALL TABLES IN SCHEMA spotidata TO spotidata_mcp;

-- Same reasoning as auth_tokens in 070: a refresh token is not library data.
REVOKE ALL ON external_tokens FROM spotidata_mcp;
