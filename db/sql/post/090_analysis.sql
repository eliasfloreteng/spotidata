-- What rbxport's tempo and key analysis walks (queue/tasks/analyse.ts).
--
-- In the `spotidata` schema because drizzle-kit is pinned to `public` and
-- would plan a DROP for anything it finds there that it did not generate.

DROP VIEW IF EXISTS spotidata.analyse_candidates CASCADE;

-- Every ISRC in the library — the music kept, not the music merely played,
-- since a DJ mixes out of what is kept. One row per ISRC, with what a Deezer
-- search needs when the ISRC alone finds nothing: the title, the first
-- credited artist and the length. The play count orders the queue, so the
-- tracks you listen to are measured first.
CREATE VIEW spotidata.analyse_candidates AS
  SELECT DISTINCT ON (ct.isrc)
         ct.isrc,
         ct.title,
         a.name AS artist,
         ct.duration_ms,
         coalesce(ps.plays, 0) AS plays
    FROM library_canonical lc
    JOIN canonical_tracks ct ON ct.id = lc.canonical_track_id
    LEFT JOIN artists a ON a.id = ct.primary_artist_id
    LEFT JOIN canonical_play_stats ps ON ps.canonical_track_id = ct.id
   WHERE ct.isrc IS NOT NULL
   ORDER BY ct.isrc, coalesce(ps.plays, 0) DESC, ct.id;

-- 070_mcp_role.sql ran before this file, so its blanket grant missed the view.
GRANT SELECT ON ALL TABLES IN SCHEMA spotidata TO spotidata_mcp;
