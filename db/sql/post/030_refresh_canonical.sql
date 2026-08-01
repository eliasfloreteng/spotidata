-- Rebuilds canonical_tracks + canonical_track_artists from spotify_tracks.
--
-- Fully idempotent and range-independent: running it twice must produce a
-- byte-identical table (asserted by scripts/verify-canonical.ts). It holds no
-- user data, so a regrouping can never destroy anything.

CREATE OR REPLACE FUNCTION spotidata.refresh_canonical_tracks()
RETURNS TABLE (groups bigint, tracks bigint) LANGUAGE plpgsql AS $$
DECLARE
  n_groups bigint;
  n_tracks bigint;
BEGIN
  -- 1. Assign every non-local track a grouping key.
  --    Precedence: manual override > ISRC > title/duration/artist heuristic.
  CREATE TEMP TABLE _k ON COMMIT DROP AS
  SELECT st.id AS track_id,
         COALESCE(
           ov.canonical_track_id,
           CASE WHEN st.isrc IS NOT NULL AND st.isrc <> ''
                THEN 'isrc:' || st.isrc
                ELSE spotidata.fallback_key(st.name, st.duration_ms, ta.ids, st.id)
           END
         ) AS cid
  FROM spotify_tracks st
  LEFT JOIN canonical_overrides ov ON ov.track_id = st.id
  LEFT JOIN LATERAL (
    SELECT array_agg(artist_id ORDER BY artist_id) AS ids
    FROM track_artists WHERE track_id = st.id
  ) ta ON true
  WHERE NOT st.is_local;

  CREATE INDEX ON _k (cid);
  CREATE INDEX ON _k (track_id);

  -- 2. Choose the copy to display for each group. A library copy wins, then
  --    the richest object, then the most popular, then the earliest original
  --    album — so the canonical page shows the "real" release rather than a
  --    random compilation. `st.id` last makes the choice deterministic.
  CREATE TEMP TABLE _rep ON COMMIT DROP AS
  SELECT DISTINCT ON (k.cid)
         k.cid, st.id, st.name, st.duration_ms, st.explicit, st.album_id
  FROM _k k
  JOIN spotify_tracks st ON st.id = k.track_id
  LEFT JOIN library_tracks lt ON lt.track_id = st.id
  LEFT JOIN albums a ON a.id = st.album_id
  ORDER BY k.cid,
           (lt.track_id IS NOT NULL) DESC,
           (st.detail_level = 'full') DESC,
           st.popularity DESC NULLS LAST,
           (a.album_type = 'album') DESC,
           a.release_date_start ASC NULLS LAST,
           st.id ASC;

  CREATE UNIQUE INDEX ON _rep (cid);

  -- 3. Group-level aggregates across every copy.
  CREATE TEMP TABLE _agg ON COMMIT DROP AS
  SELECT k.cid,
         max(st.popularity) AS max_pop,
         count(*)::int      AS n,
         min(a.release_date_start) AS earliest
  FROM _k k
  JOIN spotify_tracks st ON st.id = k.track_id
  LEFT JOIN albums a ON a.id = st.album_id
  GROUP BY k.cid;

  CREATE UNIQUE INDEX ON _agg (cid);

  INSERT INTO canonical_tracks AS c
    (id, kind, isrc, title, duration_ms, explicit, representative_track_id,
     primary_artist_id, primary_album_id, max_popularity, copy_count,
     earliest_release_date, refreshed_at)
  SELECT r.cid,
         CASE WHEN r.cid LIKE 'isrc:%' THEN 'isrc' ELSE 'fallback' END,
         CASE WHEN r.cid LIKE 'isrc:%' THEN substring(r.cid FROM 6) END,
         r.name, r.duration_ms, r.explicit, r.id,
         (SELECT artist_id FROM track_artists
           WHERE track_id = r.id ORDER BY position, artist_id LIMIT 1),
         r.album_id,
         g.max_pop, g.n, g.earliest, now()
  FROM _rep r
  JOIN _agg g ON g.cid = r.cid
  ON CONFLICT (id) DO UPDATE SET
    kind = excluded.kind,
    isrc = excluded.isrc,
    title = excluded.title,
    duration_ms = excluded.duration_ms,
    explicit = excluded.explicit,
    representative_track_id = excluded.representative_track_id,
    primary_artist_id = excluded.primary_artist_id,
    primary_album_id = excluded.primary_album_id,
    max_popularity = excluded.max_popularity,
    copy_count = excluded.copy_count,
    earliest_release_date = excluded.earliest_release_date,
    refreshed_at = now();

  -- 4. Point each Spotify track at its group.
  UPDATE spotify_tracks st
     SET canonical_track_id = k.cid
    FROM _k k
   WHERE k.track_id = st.id
     AND st.canonical_track_id IS DISTINCT FROM k.cid;

  -- Local files never join a group.
  UPDATE spotify_tracks SET canonical_track_id = NULL
   WHERE is_local AND canonical_track_id IS NOT NULL;

  -- 5. Drop groups whose every member disappeared (e.g. after an unsave and a
  --    prune). ON DELETE SET NULL on spotify_tracks keeps that safe.
  DELETE FROM canonical_tracks c
   WHERE NOT EXISTS (SELECT 1 FROM _k WHERE cid = c.id);

  -- 6. Artist credits, unioned across every copy of the recording.
  DELETE FROM canonical_track_artists;
  INSERT INTO canonical_track_artists
    (canonical_track_id, artist_id, position, on_representative)
  SELECT k.cid,
         ta.artist_id,
         min(ta.position)::smallint,
         bool_or(ta.track_id = r.id)
  FROM _k k
  JOIN track_artists ta ON ta.track_id = k.track_id
  JOIN _rep r ON r.cid = k.cid
  GROUP BY k.cid, ta.artist_id;

  SELECT count(*) INTO n_groups FROM canonical_tracks;
  SELECT count(*) INTO n_tracks FROM _k;
  RETURN QUERY SELECT n_groups, n_tracks;
END $$;

-- Checksum used to assert idempotency: rebuild twice, compare.
CREATE OR REPLACE FUNCTION spotidata.canonical_checksum()
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT md5(string_agg(
    id || '|' || kind || '|' || coalesce(isrc,'') || '|' || title || '|' ||
    duration_ms || '|' || representative_track_id || '|' ||
    coalesce(primary_artist_id,'') || '|' || coalesce(primary_album_id,'') || '|' ||
    copy_count, E'\n' ORDER BY id))
  FROM canonical_tracks;
$$;
