-- Genre as a property of a TRACK, which only MusicBrainz has.
--
-- Spotify tags the *artist*, so every song by a band inherits one career-long
-- label — "swedish pop" on a track that is a drum-and-bass remix. MusicBrainz
-- tags the recording, which is the thing a playlist is made of, and that is
-- the only source this view reads. Coverage is the price: recording tags reach
-- the recordings the enrichment crawl has matched to an ISRC and that somebody
-- has tagged, ~42% of this library, and it grows as /enrich runs.
--
-- Keyed on `canonical_tracks.id` over the whole catalog rather than the
-- library, so a genre collection and an MCP client can each restrict it their
-- own way; joining `library_canonical` costs one hash join over 8.8k rows.

DROP VIEW IF EXISTS spotidata.track_genres CASCADE;

CREATE VIEW spotidata.track_genres AS
  -- The genre test is `mb_genre_list`'s: served as a genre, or present in the
  -- curated vocabulary — which is what separates a genre from "seen live",
  -- "80s" and "favourites".
  SELECT ct.id  AS canonical_track_id,
         t.tag  AS genre,
         t.count AS votes
    FROM canonical_tracks ct
    JOIN isrc_recordings ir ON ir.isrc = ct.isrc AND ir.recording_mbid IS NOT NULL
    JOIN mb_tags t ON t.entity_type = 'recording' AND t.entity_mbid = ir.recording_mbid
   WHERE t.is_genre OR EXISTS (SELECT 1 FROM mb_genres g WHERE g.name = t.tag);

GRANT SELECT ON spotidata.track_genres TO spotidata_mcp;
