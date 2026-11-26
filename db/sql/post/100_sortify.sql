-- Sortify's song key: what the sort mode remembers verdicts and decisions by.
--
-- One level looser than a recording (see song_title_key): the remaster, the
-- radio edit and the feat. version of one song share it, so a "no" for one is
-- a "no" for all of them, and a playlist holding one is never offered another.
-- It is a hash of the normalised title and the primary artist's Spotify id,
-- not of a canonical id, so a regrouping of canonical_tracks cannot orphan the
-- rows keyed on it. A title that normalises to nothing (every word a
-- qualifier) keys on the recording instead of fusing every such track of an
-- artist into one song.
CREATE OR REPLACE FUNCTION spotidata.sortify_song_key(
  p_title text, p_recording text, p_primary_artist text
) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT 'song:' || substr(md5(
           coalesce(nullif(spotidata.song_title_key(p_title), ''), p_recording)
           || '|' || coalesce(p_primary_artist, '')), 1, 16)
$$;
