-- Rebuilds library_tracks and library_canonical.
--
-- "Library" = liked songs ∪ tracks in playlists the user owns. Playlists the
-- user merely follows are ingested for completeness but excluded here.

CREATE OR REPLACE FUNCTION spotidata.refresh_library()
RETURNS TABLE (tracks bigint, canonical bigint) LANGUAGE plpgsql AS $$
DECLARE
  n_tracks bigint;
  n_canon bigint;
BEGIN
  CREATE TEMP TABLE _lib ON COMMIT DROP AS
  WITH liked AS (
    SELECT track_id, added_at
    FROM saved_tracks
    WHERE removed_at IS NULL
  ),
  owned AS (
    SELECT pt.track_id,
           min(pt.added_at) AS added_at,
           count(DISTINCT pt.playlist_id)::int AS n_playlists
    FROM playlist_tracks pt
    JOIN playlists p ON p.id = pt.playlist_id
    WHERE p.is_owned
      AND p.removed_at IS NULL
      AND pt.track_id IS NOT NULL
      AND NOT pt.is_local
    GROUP BY pt.track_id
  )
  SELECT COALESCE(l.track_id, o.track_id)          AS track_id,
         (l.track_id IS NOT NULL)                  AS via_liked,
         (o.track_id IS NOT NULL)                  AS via_owned_playlist,
         l.added_at                                AS liked_at,
         -- A track added to a playlist years before it was liked should date
         -- from the playlist add; take the earliest evidence we have.
         LEAST(
           COALESCE(l.added_at, 'infinity'::timestamptz),
           COALESCE(o.added_at, 'infinity'::timestamptz)
         )                                          AS first_added_at,
         COALESCE(o.n_playlists, 0)                AS owned_playlist_count
  FROM liked l
  FULL OUTER JOIN owned o ON o.track_id = l.track_id;

  -- Guard: a NULL added_at on every source would poison the NOT NULL column.
  DELETE FROM _lib WHERE first_added_at = 'infinity'::timestamptz OR track_id IS NULL;

  CREATE UNIQUE INDEX ON _lib (track_id);

  DELETE FROM library_tracks lt WHERE NOT EXISTS (
    SELECT 1 FROM _lib WHERE track_id = lt.track_id);

  INSERT INTO library_tracks
    (track_id, via_liked, via_owned_playlist, liked_at, first_added_at, owned_playlist_count)
  SELECT track_id, via_liked, via_owned_playlist, liked_at, first_added_at, owned_playlist_count
  FROM _lib
  ON CONFLICT (track_id) DO UPDATE SET
    via_liked = excluded.via_liked,
    via_owned_playlist = excluded.via_owned_playlist,
    liked_at = excluded.liked_at,
    first_added_at = excluded.first_added_at,
    owned_playlist_count = excluded.owned_playlist_count;

  -- Collapse to one row per recording. This is the table the charts read.
  CREATE TEMP TABLE _libc ON COMMIT DROP AS
  SELECT st.canonical_track_id                       AS canonical_track_id,
         min(lt.first_added_at)                      AS first_added_at,
         max(lt.first_added_at)                      AS latest_added_at,
         bool_or(lt.via_liked)                       AS liked,
         count(*)::int                               AS copy_count_in_library,
         COALESCE(sum(lt.owned_playlist_count), 0)::int AS owned_playlist_count,
         max(ct.duration_ms)                         AS duration_ms,
         max(ct.primary_artist_id)                   AS primary_artist_id,
         max(ct.primary_album_id)                    AS primary_album_id,
         bool_or(ct.explicit)                        AS explicit
  FROM library_tracks lt
  JOIN spotify_tracks st ON st.id = lt.track_id
  JOIN canonical_tracks ct ON ct.id = st.canonical_track_id
  WHERE st.canonical_track_id IS NOT NULL
  GROUP BY st.canonical_track_id;

  CREATE UNIQUE INDEX ON _libc (canonical_track_id);

  DELETE FROM library_canonical lc WHERE NOT EXISTS (
    SELECT 1 FROM _libc WHERE canonical_track_id = lc.canonical_track_id);

  INSERT INTO library_canonical
    (canonical_track_id, first_added_at, latest_added_at, liked,
     copy_count_in_library, owned_playlist_count, duration_ms,
     primary_artist_id, primary_album_id, explicit)
  SELECT canonical_track_id, first_added_at, latest_added_at, liked,
         copy_count_in_library, owned_playlist_count, duration_ms,
         primary_artist_id, primary_album_id, explicit
  FROM _libc
  ON CONFLICT (canonical_track_id) DO UPDATE SET
    first_added_at = excluded.first_added_at,
    latest_added_at = excluded.latest_added_at,
    liked = excluded.liked,
    copy_count_in_library = excluded.copy_count_in_library,
    owned_playlist_count = excluded.owned_playlist_count,
    duration_ms = excluded.duration_ms,
    primary_artist_id = excluded.primary_artist_id,
    primary_album_id = excluded.primary_album_id,
    explicit = excluded.explicit;

  SELECT count(*) INTO n_tracks FROM library_tracks;
  SELECT count(*) INTO n_canon FROM library_canonical;
  RETURN QUERY SELECT n_tracks, n_canon;
END $$;

-- Marks an album complete once every one of its declared tracks is stored.
CREATE OR REPLACE FUNCTION spotidata.refresh_album_completeness()
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  WITH counted AS (
    SELECT a.id, a.total_tracks, count(st.id)::int AS have
    FROM albums a
    LEFT JOIN spotify_tracks st ON st.album_id = a.id
    GROUP BY a.id, a.total_tracks
  )
  UPDATE albums a
     SET tracks_complete = (c.total_tracks IS NOT NULL AND c.have >= c.total_tracks)
    FROM counted c
   WHERE c.id = a.id
     AND a.tracks_complete IS DISTINCT FROM
         (c.total_tracks IS NOT NULL AND c.have >= c.total_tracks);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
