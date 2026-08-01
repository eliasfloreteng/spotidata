-- Applied BEFORE the drizzle migrations: albums.release_date_start is a
-- generated column that calls this, so the function must already exist.

-- Spotify's release_date is a ragged string: "1998", "1998-03", "1998-03-14"
-- — and occasionally garbage like "0000", which makes make_date() raise and
-- takes the whole batch insert down with it. A plpgsql function can catch
-- that; a bare expression cannot.
--
-- IMMUTABLE is required for a generated column and is honest here: the result
-- depends only on the input string, with no timezone or locale involvement.
CREATE OR REPLACE FUNCTION spotidata.parse_release_date(p text)
RETURNS date LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  y int; m int; d int;
BEGIN
  IF p IS NULL OR p !~ '^\d{4}' THEN RETURN NULL; END IF;

  y := substring(p from 1 for 4)::int;
  IF y < 1 OR y > 9999 THEN RETURN NULL; END IF;

  m := CASE WHEN length(p) >= 7  AND substring(p from 6 for 2) ~ '^\d{2}$'
            THEN substring(p from 6 for 2)::int ELSE 1 END;
  d := CASE WHEN length(p) >= 10 AND substring(p from 9 for 2) ~ '^\d{2}$'
            THEN substring(p from 9 for 2)::int ELSE 1 END;

  IF m < 1 OR m > 12 THEN m := 1; END IF;
  IF d < 1 OR d > 31 THEN d := 1; END IF;

  RETURN make_date(y, m, d);
EXCEPTION WHEN OTHERS THEN
  -- e.g. 2023-02-30. Fall back to the first of the month rather than losing
  -- the row: an approximate release date still sorts and buckets correctly.
  BEGIN
    RETURN make_date(y, m, 1);
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;
END $$;
