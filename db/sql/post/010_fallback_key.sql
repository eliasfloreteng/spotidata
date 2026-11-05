-- Grouping key for the ~0.5% of tracks that carry no ISRC.

-- Strip diacritics, parenthetical/bracketed suffixes ("(feat. X)", "[Remix]"),
-- trailing " - Remastered"-style qualifiers, and all punctuation, so that
-- cosmetically different titles for one recording collapse together.
CREATE OR REPLACE FUNCTION spotidata.norm_title(p text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT btrim(regexp_replace(
           regexp_replace(
             lower(unaccent(coalesce(p, ''))),
             '\s*[\(\[][^\)\]]*[\)\]]\s*|\s+-\s+(remaster|remastered|mono|stereo|live|radio edit|single version|album version).*$',
             ' ', 'g'),
           '[^a-z0-9]+', ' ', 'g'))
$$;

-- One level looser than a recording: two ISRCs of the same *song* share it, so
-- a playlist holding the 2011 remaster is not offered the original, nor the
-- radio edit the extended mix. Strips featured-artist credits and the
-- remaster / radio-edit / original-mix / extended-mix / mono / stereo /
-- explicit qualifiers, bracketed or dashed; unlike norm_title it keeps every
-- other bracket, because "(Kygo Remix)", "(Live)" and "(Acoustic)" name a
-- different song to the person listening. Empty when nothing but qualifiers
-- remain — callers fall back to the recording id rather than fuse those.
CREATE OR REPLACE FUNCTION spotidata.song_title_key(p text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT regexp_replace(btrim(
           regexp_replace(regexp_replace(regexp_replace(lower(unaccent(coalesce(p, ''))),
             '\s*[\(\[]\s*(feat\.?|ft\.?|featuring|with|remaster(ed)?|\d{4} remaster(ed)?|radio edit|single version|album version|original mix|extended (mix|version)|mono|stereo|explicit|clean)[^\)\]]*[\)\]]', ' ', 'g'),
             '\s+-\s+(feat\.?|ft\.?|remaster(ed)?|\d{4} remaster(ed)?|\d{4} remastered version|radio edit|single version|album version|original mix|extended (mix|version)|mono|stereo)( .*)?$', ' '),
             '\s+(feat\.?|ft\.?|featuring)\s.*$', ' ')),
         '[^a-z0-9]+', '', 'g')
$$;

-- Duration is bucketed to 5 seconds so that differing masters of the same
-- recording still match. Known imperfection: a pair straddling a bucket
-- boundary splits into two groups. It can only affect the ISRC-less tail, and
-- `canonical_overrides` is the manual fix.
--
-- `p_track_id` is the refusal path. Spotify returns genuinely untitled tracks
-- (hidden interludes, silence on compilations); with no ISRC and no title the
-- heuristic has nothing left to match on but duration, and it merged 23
-- unrelated tracks into one "recording". When the normalized title is empty we
-- therefore key on the track id, giving each its own group — under-merging is
-- recoverable, silently fusing distinct recordings is not.
-- Both prior signatures must go: CREATE OR REPLACE cannot drop a
-- parameter default, and leaving the 3-arg form makes calls ambiguous.
DROP FUNCTION IF EXISTS spotidata.fallback_key(text, integer, text[]);
DROP FUNCTION IF EXISTS spotidata.fallback_key(text, integer, text[], text);
CREATE OR REPLACE FUNCTION spotidata.fallback_key(
  p_name text, p_duration integer, p_artists text[], p_track_id text
) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT 'fb:' || substr(encode(digest(
      CASE
        WHEN spotidata.norm_title(p_name) = '' AND p_track_id IS NOT NULL
          THEN 'id:' || p_track_id
        ELSE spotidata.norm_title(p_name)
             || '|' || (coalesce(p_duration, 0) / 5000)
             || '|' || array_to_string(coalesce(p_artists, '{}'), ',')
      END,
    'sha256'), 'hex'), 1, 24)
$$;
