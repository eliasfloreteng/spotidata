-- The role every statement from the MCP SQL endpoint (/api/mcp) runs as.
--
-- That endpoint is deliberately unauthenticated — an OAuth proxy fronts it in
-- deployment — so "read-only" is enforced by Postgres rather than by parsing
-- the statement: each query runs in a READ ONLY transaction that first does
-- `SET LOCAL ROLE spotidata_mcp`. Without the role switch the app connects as
-- the database owner, whose privileges bypass every REVOKE below.
--
-- Re-applied after every migration (db:migrate runs db/sql/post last), which is
-- what keeps tables added by a later migration readable.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spotidata_mcp') THEN
    CREATE ROLE spotidata_mcp NOLOGIN;
  END IF;
END $$;

-- SET ROLE is only permitted for a role the session user is a member of.
GRANT spotidata_mcp TO CURRENT_USER;

GRANT USAGE ON SCHEMA public TO spotidata_mcp;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO spotidata_mcp;

-- The hand-written helpers (norm_title, parse_release_date, fallback_key…) are
-- useful in analysis queries. The refresh_* functions in the same schema write
-- to tables this role cannot write to, inside a transaction that forbids it
-- twice over, so exposing the schema does not expose them in any useful sense.
GRANT USAGE ON SCHEMA spotidata TO spotidata_mcp;

-- The OAuth grant is not library data. A refresh token pasted into an LLM
-- context is the one row here that would actually hurt.
REVOKE ALL ON auth_tokens, auth_states FROM spotidata_mcp;

-- graphile_worker is never granted: the queue's internals are noise to an
-- analytics client and its functions are all mutating.
