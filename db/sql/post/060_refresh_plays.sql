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
 * Fills `plays.estimated_ms` for the rows the API poller wrote.
 *
 * `/me/player/recently-played` says when a stream ended and nothing else, so
 * the duration has to come from the shape of the log: both sources timestamp
 * the END of a stream, which makes the distance back to the previous play the
 * window this one had to run in, and no stream outlasts its own track. Hence
 * least(duration_ms, gap).
 *
 * Only while the previous play is close enough to have been this one's start.
 * Past that the gap says nothing — you were away — and the cap on its own would
 * award a full listen to a track that may well have been skipped after ten
 * seconds. Measured against this account's export, where the true ms_played is
 * known: contiguous plays estimate to 98.7% of the real total and land within
 * 5s on 69% of rows, while post-break plays come out at 181%. So the break rows
 * keep their NULL, and the log undercounts rather than invents.
 *
 * Recomputes every polled row rather than only the new ones: an import or a
 * backfilled poll can land a play in front of one already estimated, and the
 * answer has to follow. Idempotent, and the UPDATE touches only rows whose
 * estimate actually moved.
 */
CREATE OR REPLACE FUNCTION spotidata.estimate_poll_durations()
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  WITH ordered AS (
    SELECT p.id, p.source, p.ms_played, p.played_at, st.duration_ms,
           -- Over every play, not just the polled ones: an export row is just
           -- as good a predecessor, and after an import it usually is one.
           lag(p.played_at) OVER (ORDER BY p.played_at, p.id) AS prev_at
      FROM plays p
      LEFT JOIN spotify_tracks st ON st.id = p.track_id
  ), candidate AS (
    SELECT id, duration_ms,
           (EXTRACT(epoch FROM (played_at - prev_at)) * 1000)::bigint AS gap
      FROM ordered
     WHERE source = 'recent' AND ms_played IS NULL
  ), estimated AS (
    SELECT id,
           CASE
             -- A minute of slack for the handover between two streams; beyond
             -- that the silence is a break, not part of the play.
             WHEN gap > 0 AND gap <= duration_ms + 60000
               THEN least(duration_ms::bigint, gap)::int
           END AS est
      FROM candidate
  )
  UPDATE plays p SET estimated_ms = e.est
    FROM estimated e
   WHERE p.id = e.id AND p.estimated_ms IS DISTINCT FROM e.est;
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
 * full play. Duration is read as COALESCE(ms_played, estimated_ms) — measured
 * where the export spoke, inferred from the spacing where only the API did.
 * Rows with neither (a polled play after a break) count toward `plays` and
 * neither of the other two, because we genuinely do not know.
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
           WHERE COALESCE(p.ms_played, p.estimated_ms)
                 >= spotidata.play_completion_ms())::int         AS completed_plays,
         count(*) FILTER (
           WHERE COALESCE(p.ms_played, p.estimated_ms)
                 < spotidata.play_completion_ms())::int          AS skips,
         COALESCE(sum(COALESCE(p.ms_played, p.estimated_ms)), 0)::bigint AS ms_played,
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
