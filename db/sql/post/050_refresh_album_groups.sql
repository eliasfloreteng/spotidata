-- Rebuilds album_groups from albums + spotify_tracks.canonical_track_id.
--
-- Rudimentary album dedup: two albums are the same release when they carry the
-- same canonical tracks, ignoring order. That is deliberately the *only* signal
-- — titles differ wildly between editions ("Monsters, Inc. (Original Motion
-- Picture Soundtrack)" vs "Monsters Inc Original Soundtrack"), so matching on
-- them would both miss real duplicates and fuse unrelated releases.
--
-- Like refresh_canonical_tracks(), this holds zero user data, is idempotent,
-- and is range-independent: running it twice produces an identical table.

CREATE OR REPLACE FUNCTION spotidata.refresh_album_groups()
RETURNS TABLE (groups bigint, albums bigint) LANGUAGE plpgsql AS $$
DECLARE
  n_groups bigint;
  n_albums bigint;
BEGIN
  -- 1. Key every album.
  --
  --    Only an album we hold in FULL takes a track-set key: a half-fetched
  --    album's tracks are a subset, and a subset that happens to equal some
  --    single's track list would silently fuse a 12-track album into it. The
  --    same goes for an album carrying a track we have not grouped yet (a local
  --    file, or one still awaiting hydration). Everything else keys on its own
  --    id and stays a group of one — under-merging is recoverable, fusing two
  --    distinct releases is not.
  --
  --    The set is a multiset, not a set: an album that lists one recording
  --    twice is not the same release as one that lists it once. Newline is a
  --    safe separator because a canonical id is only ever 'isrc:<alnum>' or
  --    'fb:<hex>'.
  CREATE TEMP TABLE _ak ON COMMIT DROP AS
  WITH sets AS (
    SELECT a.id AS album_id,
           count(st.canonical_track_id)::int                        AS n_tracks,
           count(*) FILTER (WHERE st.canonical_track_id IS NULL)    AS ungrouped,
           string_agg(st.canonical_track_id, E'\n'
                      ORDER BY st.canonical_track_id)               AS members
    FROM albums a
    LEFT JOIN spotify_tracks st ON st.album_id = a.id
    GROUP BY a.id
  )
  SELECT s.album_id,
         CASE
           WHEN a.tracks_complete AND s.ungrouped = 0 AND s.n_tracks > 0
             THEN 'trk:' || substr(encode(digest(s.members, 'sha256'), 'hex'), 1, 24)
           ELSE 'alb:' || s.album_id
         END        AS gid,
         s.n_tracks
  FROM sets s
  JOIN albums a ON a.id = s.album_id;

  CREATE UNIQUE INDEX ON _ak (album_id);
  CREATE INDEX ON _ak (gid);

  -- 2. Choose the edition to display. A saved album wins, then the richest
  --    object, then a proper album over a single or a compilation, then
  --    popularity, then the earliest release — so the group resolves to the
  --    original rather than to a later regional re-issue. `a.id` last makes it
  --    deterministic.
  CREATE TEMP TABLE _arep ON COMMIT DROP AS
  SELECT DISTINCT ON (k.gid)
         k.gid, a.id, a.name, k.n_tracks
  FROM _ak k
  JOIN albums a ON a.id = k.album_id
  LEFT JOIN saved_albums sa ON sa.album_id = a.id AND sa.removed_at IS NULL
  ORDER BY k.gid,
           (sa.album_id IS NOT NULL) DESC,
           (a.detail_level = 'full') DESC,
           (a.album_type = 'album') DESC,
           a.popularity DESC NULLS LAST,
           a.release_date_start ASC NULLS LAST,
           a.id ASC;

  CREATE UNIQUE INDEX ON _arep (gid);

  -- 3. Group-level aggregates across every edition.
  CREATE TEMP TABLE _aagg ON COMMIT DROP AS
  SELECT k.gid,
         count(*)::int             AS n,
         min(a.release_date_start) AS earliest
  FROM _ak k
  JOIN albums a ON a.id = k.album_id
  GROUP BY k.gid;

  CREATE UNIQUE INDEX ON _aagg (gid);

  INSERT INTO album_groups AS g
    (id, kind, title, representative_album_id, primary_artist_id,
     track_count, copy_count, earliest_release_date, refreshed_at)
  SELECT r.gid,
         CASE WHEN r.gid LIKE 'trk:%' THEN 'tracks' ELSE 'solo' END,
         r.name,
         r.id,
         (SELECT artist_id FROM album_artists
           WHERE album_id = r.id ORDER BY position, artist_id LIMIT 1),
         r.n_tracks,
         g2.n,
         g2.earliest,
         now()
  FROM _arep r
  JOIN _aagg g2 ON g2.gid = r.gid
  ON CONFLICT (id) DO UPDATE SET
    kind = excluded.kind,
    title = excluded.title,
    representative_album_id = excluded.representative_album_id,
    primary_artist_id = excluded.primary_artist_id,
    track_count = excluded.track_count,
    copy_count = excluded.copy_count,
    earliest_release_date = excluded.earliest_release_date,
    refreshed_at = now();

  -- 4. Point each album at its group.
  UPDATE albums a
     SET album_group_id = k.gid
    FROM _ak k
   WHERE k.album_id = a.id
     AND a.album_group_id IS DISTINCT FROM k.gid;

  -- 5. Drop groups nothing points at any more (an album pruned, or an edition
  --    that changed key after hydration filled in an ISRC).
  DELETE FROM album_groups g
   WHERE NOT EXISTS (SELECT 1 FROM _ak WHERE gid = g.id);

  SELECT count(*) INTO n_groups FROM album_groups WHERE kind = 'tracks' AND copy_count > 1;
  SELECT count(*) INTO n_albums FROM _ak;
  RETURN QUERY SELECT n_groups, n_albums;
END $$;

-- Checksum used to assert idempotency: rebuild twice, compare.
CREATE OR REPLACE FUNCTION spotidata.album_group_checksum()
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT md5(string_agg(
    id || '|' || kind || '|' || title || '|' || representative_album_id || '|' ||
    coalesce(primary_artist_id,'') || '|' || track_count || '|' || copy_count,
    E'\n' ORDER BY id))
  FROM album_groups;
$$;
