-- Applied BEFORE drizzle migrations: the trigram indexes in the generated
-- migration reference gin_trgm_ops, and fallback_key() needs digest().

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Everything hand-written lives in its own schema so drizzle-kit (which is
-- pinned to `public` via schemaFilter) never sees it as drift.
CREATE SCHEMA IF NOT EXISTS spotidata;

-- The database role is also called `spotidata`, so the stock search_path of
-- `"$user", public` would resolve unqualified CREATE TABLE into the schema
-- above and hide every table from drizzle-kit's `public` filter. Pin it.
-- ALTER DATABASE affects new sessions; SET fixes the session applying this.
ALTER DATABASE spotidata SET search_path TO public;
SET search_path TO public;
