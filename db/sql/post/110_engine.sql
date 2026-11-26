-- Deckhand's engine (engine/, the stack's second service) and this database.
--
-- The engine keeps its own state in the schema `deckhand`, which it creates
-- and migrates itself (engine/server/migrations/). It connects with this
-- stack's credentials but runs every statement as the role `deckhand`
-- (DECKHAND_DATABASE_ROLE), which is granted nothing of Spotidata's but the
-- two views below. So "the engine only reads Spotidata" is Postgres's to
-- enforce, not a convention: it cannot write a row outside its schema, and
-- cannot read the OAuth grant at all.
--
-- The other direction needs no grant: Spotidata connects as the database
-- owner and reads `deckhand.recordings` (tempo, key, which recordings are
-- downloaded). The engine grants the MCP role what it may read of its schema
-- in its own migrations, since it owns those tables.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'deckhand') THEN
    CREATE ROLE deckhand NOLOGIN;
  END IF;
END $$;

-- SET ROLE is only permitted for a role the session user is a member of.
GRANT deckhand TO CURRENT_USER;

-- To create its schema on first start.
DO $$
BEGIN
  EXECUTE format('GRANT CREATE ON DATABASE %I TO deckhand', current_database());
END $$;

-- The playlists, as the engine reads them to keep the ones you pick: one row
-- each, whether the account lists it or it was fetched by its link.
--   listed          in the account's playlists (followed or owned) at the last listing
--   items_snapshot  the snapshot whose tracks spotidata.engine_playlist_tracks holds;
--                   null while they have never been read
DROP VIEW IF EXISTS spotidata.engine_playlists;
CREATE VIEW spotidata.engine_playlists AS
  SELECT p.id,
         p.name,
         coalesce(u.display_name, p.owner_id, '') AS owner,
         p.is_owned AS owned,
         (SELECT i.url FROM playlist_images i WHERE i.playlist_id = p.id
           ORDER BY (coalesce(i.width, 0) < 200), coalesce(i.width, 0) LIMIT 1) AS image,
         coalesce(p.total_tracks, 0) AS tracks,
         p.snapshot_id,
         p.items_synced_snapshot_id AS items_snapshot,
         p.items_synced_at,
         p.removed_at IS NULL AS listed
    FROM playlists p
    LEFT JOIN spotify_users u ON u.id = p.owner_id;

-- Each playlist's tracks in Spotify's order, episodes and unavailable items
-- left out. A local file has no track_id and no ISRC, only its name.
DROP VIEW IF EXISTS spotidata.engine_playlist_tracks;
CREATE VIEW spotidata.engine_playlist_tracks AS
  SELECT pt.playlist_id,
         pt.position,
         st.id AS track_id,
         coalesce(st.name, pt.local_name, '') AS title,
         CASE WHEN st.id IS NULL
              THEN array_remove(ARRAY[pt.local_artist], NULL)
              ELSE ARRAY(SELECT ar.name FROM track_artists ta JOIN artists ar ON ar.id = ta.artist_id
                          WHERE ta.track_id = st.id ORDER BY ta.position)
         END AS artists,
         coalesce(al.name, '') AS album,
         nullif(upper(trim(st.isrc)), '') AS isrc,
         coalesce(st.duration_ms, 0) AS duration_ms,
         (SELECT i.url FROM album_images i WHERE i.album_id = st.album_id
           ORDER BY (coalesce(i.width, 0) < 200), coalesce(i.width, 0) LIMIT 1) AS cover
    FROM playlist_tracks pt
    LEFT JOIN spotify_tracks st ON st.id = pt.track_id AND NOT pt.is_local
    LEFT JOIN albums al ON al.id = st.album_id
   WHERE pt.is_local OR st.id IS NOT NULL;

GRANT USAGE ON SCHEMA spotidata TO deckhand;
GRANT SELECT ON spotidata.engine_playlists, spotidata.engine_playlist_tracks TO deckhand, spotidata_mcp;
