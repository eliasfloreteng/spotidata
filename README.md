# Spotidata

A single-user monolith that ingests a Spotify account into local Postgres and
presents it as a dark, chart-heavy dashboard, resyncing in the background.

Bun · TypeScript · SvelteKit 2 (Svelte 5 runes) · Postgres 18 · Drizzle v1 ·
Graphile Worker · d3 v7.

![The dashboard: library totals, then a per-year calendar of tracks added](docs/screenshots/dashboard-hero.png)

*Top of the dashboard — [see the whole page](docs/screenshots/dashboard.png), sixteen
charts over a 8.8k-recording library.*

## Why local ingest

The Spotify API is shrinking — audio-features, recommendations and
related-artists are gone (403/404), editorial playlists are unreachable, and
`preview_url` is permanently null. It is also rate-limited to roughly 3 req/s
with no published number. Track metadata barely changes, so the design pulls
everything once and keeps it.

## Quick start

```bash
cp .env.example .env          # fill in SPOTIFY_CLIENT_ID / SECRET
bun install
bun run db:up                 # postgres:18-trixie via docker compose
bun run db:migrate            # extensions → drizzle migrations → SQL functions → seed
bun run dev                   # http://127.0.0.1:5173
```

Then open `/auth/login` and approve. Trigger the first sync from `/sync`, and
drop a Spotify export on `/history/import` for the listening history — an
existing grant made before `user-read-recently-played` was added needs
re-authorizing, which that page says so.

**Redirect URIs** must be registered on the Spotify app exactly as:

```
http://127.0.0.1:5173/auth/callback     (dev)
http://127.0.0.1:4173/auth/callback     (preview)
```

Spotify rejects `localhost`; the loopback IP literal is the only non-HTTPS
exception.

Set `MUSICBRAINZ_CONTACT` too — a URL or email. MusicBrainz blocks clients that
do not identify themselves, and it is the only thing enrichment needs.

## Scripts

| Command | Purpose |
|---|---|
| `bun run verify` | tsc + migration guard + SQL convention lint |
| `bun run probe` | Live API contract test (13 endpoints) |
| `bun run db:reset` | Backs up the OAuth grant, recreates the DB, restores it |
| `bun run db:backup -- --full` | `pg_dump` alongside the grant |
| `bun run db:generate` | New migration + guard against touching the queue schema |

## Design decisions worth knowing

**A track is an ISRC.** `canonical_tracks` groups every Spotify track id sharing
a recording — this library has 10,809 library tracks across 8,828 recordings.
The table holds zero user data and is rebuilt idempotently by
`spotidata.refresh_canonical_tracks()`; anything user-authored keys on
`spotify_tracks.id` so a regrouping can never orphan it.

![A track page listing eleven Spotify ids that share one ISRC](docs/screenshots/track-page.png)

*One recording, eleven track ids — singles, album cuts, deluxe editions and
regional releases all collapse onto the same page.*

**An album is its track list.** `album_groups` collapses editions the same way:
two albums are one release when they carry the same canonical tracks, ignoring
order — 17,868 albums fall into 16,964 groups, with 824 groups holding a genuine
duplicate. Titles are never compared ("Monsters, Inc. (Original Motion Picture
Soundtrack)" and "Monsters Inc Original Soundtrack" are the same record), and
only albums held in full are eligible, so a half-fetched album can never be
fused into a single that happens to match its subset.

**The library** is liked songs ∪ tracks in playlists you own. Other playlists
are ingested in full but excluded from library statistics.

**Listening is a separate fact from saving**, and the two disagree constantly:
17% of this account's plays are of recordings it never saved, and 801 saved
recordings have never been played at all. `plays` is one row per stream event,
keyed on `spotify_tracks.id` — never on the canonical id, so a regrouping
cannot orphan one — and `/history` reads it in hours rather than saves.

Two sources feed it, and they describe the same play differently. The extended
streaming history export is the whole record back to the first play, with how
long each stream ran and why it stopped; `/me/player/recently-played` is a
50-item window polled every 20 minutes, which knows neither. **Re-importing the
same archive is free**: the unique key is `(played_at, item_uri, ms_played)`
with `NULLS NOT DISTINCT`. Duration is in the key because the export genuinely
repeats rows — 565 (uri, second) pairs in 167k plays, half of them Spotify's log
emitting one stream twice and half two real streams ending in the same second
while skipping through a queue. `NULLS NOT DISTINCT` is what stops the API
source, whose `ms_played` is always null, inserting afresh on every poll.

**A polled play still gets a listening time**, just not from Spotify. Both
sources timestamp the *end* of a stream, so the distance back to the previous
play is the window this one had to run in, and no stream outlasts its own track:
`least(duration_ms, gap)`, written to `estimated_ms` by
`spotidata.estimate_poll_durations()` and summed as
`coalesce(ms_played, estimated_ms)` everywhere. Checked against the export,
where the truth is recorded: it lands within 5 seconds on 69% of plays and sums
to 98.7% of the real total. The first play after a break keeps a null — with
nothing to measure against, the cap alone would award a full listen to a track
that may have been skipped after ten seconds, and it reads 181% of true time on
exactly those rows. So the log undercounts rather than invents, and the app
marks an inferred duration `~3:12`.

**The zip reader is hand-written** (`src/lib/server/import/zip.ts`). The whole
requirement is "list the entries, hand me one"; Node ships the inflater, and the
container is the missing 150 lines. Entries are read from their offsets rather
than by streaming the archive front to back, so a 470 MB export costs one file
handle and one 13 MB file at a time — the full import runs in six seconds.

**Only the extended export is accepted.** The much faster "Account data"
download carries `StreamingHistory_music_N.json` instead: one year, timestamps
to the minute, no track URIs. It is a strict subset of what the extended export
says with no reliable way to match the overlap, so the importer names the file
it found and explains what to request instead.

![The liked songs table, sortable and searchable](docs/screenshots/liked-page.png)

**Bulk endpoints still work**, contrary to widespread claims. `/albums?ids=`
takes 20 ids *and embeds each album's first 50 tracks*, which is why a full
sync of ~70k tracks costs ~2,600 requests rather than ~170,000.

**Incremental sync** uses two levers: playlist `snapshot_id` gating, and the
newest-first `added_at` watermark on `/me/tracks`. A no-change resync makes
**17 requests**. Early stop cannot see removals, so a count mismatch forces a
full pass and cron runs a full reconciliation weekly.

**Rate limiting lives in Postgres** — a token bucket plus a circuit breaker.
In memory it would evaporate on restart, and a `Retry-After` measured in hours
must survive that. A 429 halves the rate; `maintenance:rate-recover` ramps it
back (AIMD). While the breaker is open, Graphile Worker's `forbiddenFlags`
skips every Spotify job wholesale instead of burning retries.

**MusicBrainz fills in what Spotify deleted.** `/audio-features` is gone, and
Spotify never had genres per track or an artist's country of origin. MusicBrainz
has all of it, and AcousticBrainz still serves the BPM and musical key it
collected before submissions closed in 2022. The seam between the two catalogs
is the **ISRC** — the only identifier they genuinely share — so
`isrc_recordings` maps it to a recording MBID and every enrichment hangs off
that, never off the derived `canonical_tracks.id` that a regrouping would
invalidate.

The shape is dictated by the rate limit: one request per second per IP, no
batch lookup, no way to buy more. So it is one self-chaining job that does a
bounded slice and re-enqueues itself, ordered by play count so the music you
actually listen to gets its genres in the first hour rather than the twentieth.
Two things keep it affordable — every ISRC lookup returns the recording's full
artist credit, so `match_artists_by_credit()` links thousands of artists in one
SQL statement and no requests at all; and every miss is *recorded*, so a
recording MusicBrainz has never heard of costs one request ever, not one per
pass. Progress, per-stage coverage and the controls live at `/enrich`.

OAuth is supported and unnecessary: the web service is open, and a grant does
not raise the rate limit. It is there for a future write path.

**A genre is two opinions, so `/genres` keeps both.** MusicBrainz tags the
*recording*, which is what a playlist is made of, but only reaches 42% of this
library; Spotify tags the *artist*, so every song by a band inherits one
career-long label — and that reaches 72%. They do not share a vocabulary
either: MusicBrainz says "synth-pop" where Spotify says "swedish pop". So
`spotidata.track_genres` unions them with a `source` column and the page makes
that a filter rather than trying to reconcile it.

The page exists to build a playlist Spotify itself cannot: pick any number of
genres (any of them, or all of them at once), work down the tracks striking off
what does not belong, and copy `open.spotify.com/track/…` links to paste
straight into a playlist. The links come from `/genres/links`, which serves the
same selection in the same order as plain text — so the copy is exactly the
list you were reading, and opening that URL is the whole feature with
JavaScript switched off. Removals are keyed on the track id, which is what lets
them survive paging through 1,200 results, and the paste goes out in batches of
100 because that is what the client swallows in one go.

**Analytics are raw SQL, no materialized views.** Every chart is a `GROUP BY`
over `library_canonical` (8.8k rows, resident in shared buffers) — all sixteen
dashboard queries run in ~130 ms total. MVs also cannot be parameterized by an
arbitrary time range, which the range picker requires.

**Charts are d3 for maths, Svelte for DOM** — no `d3-selection`. Every component
in `src/lib/charts` renders at `/_charts` against synthetic data, including the
empty and single-point cases that are easy to get wrong.

<details>
<summary>The chart gallery (click to expand)</summary>

![Every chart component rendered against synthetic data](docs/screenshots/charts-gallery.png)

</details>

**`/api/mcp` hands the database to an AI client** over the Model Context
Protocol: one `query` tool running read-only SQL, plus `describe_schema` and
`get_business_rules`. Read-only is enforced by Postgres — every statement runs
in a `BEGIN READ ONLY` transaction under `SET LOCAL ROLE spotidata_mcp`, a role
granted `SELECT` and nothing else, which also puts the OAuth tables out of
reach. Statement-inspecting allowlists were not considered: they have to be
right about every way of spelling a write, forever.

The interesting half is the *metadata*. A model pointed at this schema will
count `spotify_tracks` and overstate the library by 19%, bucket dates in UTC and
move an evening save to the next day, and let a greatest-hits package outrank
the albums the library is built from — confidently, every time. So the server
instructions and the tool descriptions carry the domain rules (a track is an
ISRC; the library is liked ∪ owned-playlist tracks; compilations are excluded;
derived tables are rebuilt, never edited), and the schema is read live from
`pg_catalog` — including the CHECK constraints, which are where the allowed
values of every text column are actually written down. Row counts are exact,
because `reltuples` was off by 73% on the table that matters most.

```bash
claude mcp add --transport http spotidata http://127.0.0.1:5173/api/mcp
```

## Traps this codebase has already hit

Each of these failed silently rather than loudly, so they have guards:

- **Raw SQL returns timestamps as strings.** Drizzle configures node-postgres
  that way and maps them itself only in the query builder. `someDate <= thatString`
  is always false — this disabled the liked-songs early stop for a whole sync.
  `bun run lint:sql` now fails the build on an uncast `max(added_at)`.
- **A JS array interpolated into `sql` becomes a row constructor**, not an
  array. Use the helpers in `src/lib/server/db/arrays.ts`.
- **Circular imports break Graphile Worker job specs.** `constants.ts` imports
  nothing for this reason; a cycle left `SPOTIFY_FLAG` undefined and every job
  was queued with `flags: [null]`.
- **Concurrent upserts deadlock.** `dedupeBy` sorts by key so all transactions
  lock in the same order, and `runLeafTask` retries on SQLSTATE 40P01 without
  re-issuing the HTTP request.
- **drizzle-kit v1 defaults `schemaFilter` to all schemas** and would drop
  `graphile_worker`. Pinned to `public`, with `scripts/check-migration.ts` as a
  build-failing backstop.
- **Timestamptz arithmetic is STABLE, not IMMUTABLE**, so it cannot back a
  generated column. `refresh_expires_at` pins both conversions to UTC.
- **Worker task code does not hot-reload.** Graphile Worker captures `taskList`
  at startup; restart the dev server after editing anything under `queue/tasks`.
- **A per-row lookup on an unindexed column is invisible until the row count
  is.** Resolving each play's URI through `linked_from_id` was a sequential scan
  of 96k tracks, 167k times: the first import ran for ten minutes without
  inserting a row. It is now a primary-key join, with relinking handled once per
  *distinct* URI by `spotidata.link_plays()` and an index behind it.
- **adapter-node caps a request body at 512 KB** and rejects it before the
  handler runs. `BODY_SIZE_LIMIT` is set in the Dockerfile so a ~500 MB history
  upload survives; the route enforces its own ceiling against the bytes that
  actually arrive, since Content-Length is a claim.
- **node-postgres reads a zoneless `date`/`timestamp` in the server's local
  offset.** Serialising that back out as an instant shifts it: an MCP client
  asking for `date_trunc('year', … at time zone 'Europe/Stockholm')::date` got
  "2025-12-31T23:00:00.000Z" for the 2026 bucket. `mcp/query.ts` returns those
  four types as the text Postgres wrote; `timestamptz` stays an instant.

## Layout

```
db/migrations/     committed drizzle output
db/sql/pre/        extensions + parse_release_date (migrations depend on them)
db/sql/post/       fallback_key, rate limiter, refresh_canonical, refresh_library,
                   refresh_album_groups, refresh_plays, mcp_role,
                   external_limiter, enrichment
src/lib/server/    db/ spotify/ musicbrainz/ ingest/ import/ queue/ stats/
                   entities/ mcp/
src/lib/charts/    d3 computes, Svelte renders — no d3-selection
src/routes/        dashboard, entity pages, /history, /sync, /enrich, /settings, /api
scripts/           probe-api, apply-sql, check-migration, check-sql-conventions,
                   backup, restore-auth, spike-worker
```

Nothing under `src/lib/server` may import `$lib`, `$env/*` or `Bun.*`: the same
modules run under Bun (SvelteKit) and plain Node (`bun run worker`), so
`WORKER_MODE=external` is a one-line change.

## Not built yet

Beatport enrichment; Telegram re-auth alerts.
