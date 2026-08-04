-- Listening history: link plays to the catalog, then roll them up per recording.
--
-- Both functions are idempotent and hold no data that is not recomputable from
-- `plays` + `spotify_tracks`, so a regrouping or a re-import can be followed by
-- a plain re-run.

-- A stream counts as "listened to" past this many milliseconds. Spotify's own
-- 30-second threshold is the one every listener has internalised from Wrapped,
-- and it is the line below which a play is really a skip.
CREATE OR REPLACE FUNCTION spotidata.play_completion_ms()
RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 30000 $$;

/*
 * Attaches `plays.track_id` to the catalog row its URI names.
 *
 * Two joins, not one. The direct id match is the common case; `linked_from_id`
 * catches track relinking, where the id Spotify logged in one market has since
 * been superseded by another row — without it those plays stay unresolved
 * forever even though the recording is sitting right there.
 *
 * Only NULL track_ids are considered, so this is cheap to run after every
 * ingest: the partial index on (item_uri) WHERE track_id IS NULL is the driver.
 */
CREATE OR REPLACE FUNCTION spotidata.link_plays()
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  WITH unresolved AS (
    SELECT DISTINCT item_uri,
           substring(item_uri from 'spotify:track:(.+)$') AS raw_id
      FROM plays
     WHERE track_id IS NULL AND item_kind = 'track'
  ), matched AS (
    SELECT u.item_uri,
           -- A relinked row can match several requested ids; take one
           -- deterministically rather than multiplying the update.
           (SELECT st.id FROM spotify_tracks st
             WHERE st.id = u.raw_id OR st.linked_from_id = u.raw_id
             ORDER BY (st.id = u.raw_id) DESC, st.id
             LIMIT 1) AS track_id
      FROM unresolved u
     WHERE u.raw_id IS NOT NULL
  )
  UPDATE plays p
     SET track_id = m.track_id
    FROM matched m
   WHERE p.item_uri = m.item_uri
     AND p.track_id IS NULL
     AND m.track_id IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

/*
 * Rebuilds canonical_play_stats.
 *
 * The rollup exists so a list page can order 8.8k recordings by play count
 * without grouping 167k events per request. Anything the range picker touches
 * still reads `plays` directly — a rollup cannot be re-cut by an arbitrary
 * window, which is the same reason the library charts have no materialized
 * views.
 *
 * `skips` counts streams that ended before the completion threshold, whatever
 * the export's own `skipped` flag says: that flag is only ever set by the
 * client's skip button, so a track abandoned by closing the app reads as a
 * full play. Rows with a NULL ms_played (the API source) count toward `plays`
 * and neither of the other two, because we genuinely do not know.
 */
CREATE OR REPLACE FUNCTION spotidata.refresh_play_stats()
RETURNS TABLE (recordings bigint, events bigint) LANGUAGE plpgsql AS $$
DECLARE
  n_rec bigint;
  n_events bigint;
BEGIN
  CREATE TEMP TABLE _cps ON COMMIT DROP AS
  SELECT st.canonical_track_id                                   AS canonical_track_id,
         count(*)::int                                           AS plays,
         count(*) FILTER (
           WHERE p.ms_played >= spotidata.play_completion_ms())::int AS completed_plays,
         count(*) FILTER (
           WHERE p.ms_played < spotidata.play_completion_ms())::int   AS skips,
         COALESCE(sum(p.ms_played), 0)::bigint                   AS ms_played,
         min(p.played_at)                                        AS first_played_at,
         max(p.played_at)                                        AS last_played_at
    FROM plays p
    JOIN spotify_tracks st ON st.id = p.track_id
   WHERE st.canonical_track_id IS NOT NULL
   GROUP BY st.canonical_track_id;

  CREATE UNIQUE INDEX ON _cps (canonical_track_id);

  DELETE FROM canonical_play_stats cps WHERE NOT EXISTS (
    SELECT 1 FROM _cps WHERE canonical_track_id = cps.canonical_track_id);

  INSERT INTO canonical_play_stats
    (canonical_track_id, plays, completed_plays, skips, ms_played,
     first_played_at, last_played_at, refreshed_at)
  SELECT canonical_track_id, plays, completed_plays, skips, ms_played,
         first_played_at, last_played_at, now()
  FROM _cps
  ON CONFLICT (canonical_track_id) DO UPDATE SET
    plays = excluded.plays,
    completed_plays = excluded.completed_plays,
    skips = excluded.skips,
    ms_played = excluded.ms_played,
    first_played_at = excluded.first_played_at,
    last_played_at = excluded.last_played_at,
    refreshed_at = now();

  SELECT count(*) INTO n_rec FROM canonical_play_stats;
  SELECT count(*) INTO n_events FROM plays;
  RETURN QUERY SELECT n_rec, n_events;
END $$;
