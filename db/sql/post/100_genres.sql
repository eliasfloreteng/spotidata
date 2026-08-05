-- Genre as a property of a TRACK, from the only two catalogs that have one.
--
-- Spotify never tagged a track with a genre — it tags the *artist*, so every
-- song by a band inherits one career-long label. MusicBrainz tags the
-- recording, which is what a playlist is actually made of, but only for the
-- recordings the enrichment crawl has reached (an ISRC match plus somebody
-- having tagged it). Neither covers the library on its own — on this account
-- recording tags reach 42% of it and artist genres 72% — so both arms are
-- kept, labelled by `source`, and the caller chooses.
--
-- Keyed on `canonical_tracks.id` over the whole catalog rather than the
-- library, so /genres and the MCP client can each restrict it their own way;
-- joining `library_canonical` costs one hash join over 8.8k rows.

DROP VIEW IF EXISTS spotidata.track_genres CASCADE;

CREATE VIEW spotidata.track_genres AS
  -- MusicBrainz recording tags. The genre test is `mb_genre_list`'s: served as
  -- a genre, or present in the curated vocabulary — which is what separates a
  -- genre from "seen live", "80s" and "favourites".
  SELECT ct.id                AS canonical_track_id,
         t.tag                AS genre,
         'recording'::text    AS source,
         t.count              AS votes
    FROM canonical_tracks ct
    JOIN isrc_recordings ir ON ir.isrc = ct.isrc AND ir.recording_mbid IS NOT NULL
    JOIN mb_tags t ON t.entity_type = 'recording' AND t.entity_mbid = ir.recording_mbid
   WHERE t.is_genre OR EXISTS (SELECT 1 FROM mb_genres g WHERE g.name = t.tag)
  UNION ALL
  -- Spotify artist genres, credited artists only. DISTINCT because two artists
  -- on the same track routinely carry the same genre, and a track must appear
  -- once per genre or every count over this view doubles.
  SELECT DISTINCT
         cta.canonical_track_id,
         ag.genre,
         'artist'::text,
         0
    FROM canonical_track_artists cta
    JOIN artist_genres ag ON ag.artist_id = cta.artist_id
   WHERE cta.on_representative;

GRANT SELECT ON spotidata.track_genres TO spotidata_mcp;
