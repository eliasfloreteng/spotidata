# Spotidata: notes for agents

Read README.md first. Spotidata is the whole backend of one person's music
tools: the Spotify archive and dashboard (SvelteKit, `src/`), Sortify's API
(`/api/sortify`) and Deckhand's engine (`engine/`, Rust), which runs as a
second service in the same stack and database.

- Production is `/opt/stacks/spotidata` on `elias-pi-01` and redeploys on push
  to `main` (the `deployer`). The committed `compose.yaml` only brings up the
  dev database; the app and engine services, their Traefik labels and mounts
  are the Pi's `compose.override.yaml`, outside git. Change them there.
- Nothing under `src/lib/server` may import `$lib`, `$env/*` or `Bun.*` (the
  worker runs it under plain Node). Raw SQL returns timestamps as strings, and
  a JS array interpolated into `sql` is a row constructor: see README › Traps.
- A Drizzle schema change is `bun run db:generate`, never a hand-written
  migration of `public`; hand-written SQL for the `spotidata` schema lives in
  `db/sql/post/` (idempotent, re-run on every start) or, for a one-time drop,
  a `--custom` migration.
- Verify with `bun run verify`, `bun run check` and `bun run build`; the
  engine with `cargo test` and `cargo clippy --all-targets` in `engine/` (its
  tests need a Postgres in `DATABASE_URL`, README › Deckhand's engine ›
  Develop).

## The engine (`engine/`)

- It keeps its state in the schema `deckhand`, which it owns and migrates at
  startup (`engine/server/migrations/`, sqlx). A schema change is a new
  migration file, never an edit to an applied one. It runs as the role
  `deckhand` (`DECKHAND_DATABASE_ROLE`), granted nothing of Spotidata's but
  the views in `db/sql/post/110_engine.sql`: it reads Spotidata, read-only,
  and never touches another schema. A new table it adds that the MCP may read
  needs its own `grant select … to spotidata_mcp` in that migration (never
  `devices` or `meta`: phones' push tokens and the sources' passes).
- Spotidata reads the engine through `deckhand.recordings` (tempo, key, what
  is downloaded; `src/lib/server/engine/recordings.ts`), which falls back to
  an empty stand-in while the schema doesn't exist. Tempo and key come only
  from the real files.
- Spotify is read only through Spotidata (`/api/engine/*`, so through
  `spotifyFetch` and the one rate limiter), never directly. Against the real
  account from a test engine, only read; don't keep playlists.
- The music folder (`/home/pi/music` on the Pi, mounted at `/music`) is
  synced to the stick by Syncthing. The engine only adds audio there (staged
  in `/data/downloads`, then `.syncthing.*.tmp` + hard link, so it never
  replaces or deletes a file). The one exception is the `.m3u8` of each kept
  Spotify playlist: rewritten as the playlist changes, deleted (if unedited)
  when it is no longer kept.
- Download sources are free community mirrors that come and go. Each is a
  `Source` in `engine/server/src/downloads/sources/`; ranking and fallbacks
  are generic (`health.rs`, `mod.rs`). Test one alone with
  `DECKHAND_SOURCES_OFF=<the others>`. Deezer stays a download source; the
  catalog the apps search is Spotify's.
- The APNs key is `/opt/stacks/spotidata/secrets/apns.p8` on the Pi, its id
  `APNS_KEY_ID` in the stack's `.env`, both outside git.
- **rbxport rev:** `engine/Cargo.toml` and Deckhand's `crates/core`
  (`Cargo.toml` in the Deckhand repository) must pin the same rbxport rev: the
  exporter on the phone reads the analysis blobs the engine writes and its
  `SourceTrack`s. Bump it in both together, then in Deckhand move the
  `deckhand-model` git rev to the Spotidata commit that did it and rebuild the
  XCFramework (`scripts/build-core.sh`); Deckhand's tests fail on a mismatch.
- `engine/model` is the manifest the apps read; Deckhand's `crates/core`
  depends on it by git rev from this repository. A change to it reaches the
  apps only when Deckhand moves that rev.
- The apps reach the engine at `https://spotidata.eliasf.se/deckhand`
  (Traefik strips `/deckhand`); its routes are its own, under `/api/…`.
