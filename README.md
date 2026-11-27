# Spotidata

A single-user monolith that ingests a Spotify account into local Postgres and
presents it as a dark, chart-heavy dashboard, resyncing in the background. It
is also the whole backend of [Sortify](https://github.com/eliasfloreteng/sortify)
(`/api/sortify`) and of [Deckhand](https://github.com/eliasfloreteng/deckhand),
the DJ-stick syncer, whose engine (`engine/`, Rust) runs beside the app in the
same stack and the same database.

Bun · TypeScript · SvelteKit 2 (Svelte 5 runes) · Postgres 18 · Drizzle v1 ·
Graphile Worker · d3 v7 · Rust (the engine).

![The overview: listening and library totals, then how saved recordings met the listening](docs/screenshots/dashboard-hero.png)

*Top of the overview — [see the whole page](docs/screenshots/dashboard.png): what was
saved and what was played, over one range, a 9.1k-recording library and 184k plays.*

## Why local ingest

The Spotify API is shrinking — audio-features, recommendations and
related-artists are gone (403/404), editorial playlists are unreachable, and
`preview_url` is permanently null. It is also rate-limited to roughly 3 req/s
with no published number. Track metadata barely changes, so the design pulls
everything once and keeps it.

## Quick start

```bash
cp .env.example .env          # fill in SPOTIFY_CLIENT_ID / SECRET (+ OPENROUTER_API_KEY for Sortify)
bun install
bun run db:up                 # postgres:18-trixie via docker compose
bun run db:migrate            # extensions → drizzle migrations → SQL functions → seed
bun run dev                   # http://127.0.0.1:5173
```

Then open `/auth/login` and approve. Trigger the first sync from `/sync`, and
drop a Spotify export on `/history/import` for the listening history. Scopes
are only ever granted once, so a grant made before a feature existed does not
carry its scope — `user-read-recently-played` for the history,
`playlist-modify-private`/`-public` for the playlists `/automations`, `/dj` and
Sortify write, and `user-read-playback-state`/`user-modify-playback-state` for
Sortify's playback. Every page and API that needs one checks the stored scope
and links to a re-authorization when it is missing; re-authorizing keeps every row
you have already ingested.

**Redirect URIs** must be registered on the Spotify app exactly as:

```
http://127.0.0.1:5173/auth/callback     (dev)
http://127.0.0.1:4173/auth/callback     (preview)
```

Spotify rejects `localhost`; the loopback IP literal is the only non-HTTPS
exception.

## Scripts

| Command | Purpose |
|---|---|
| `bun run verify` | tsc + migration guard + SQL convention lint |
| `bun run probe` | Live API contract test (13 endpoints) |
| `bun run db:reset` | Backs up the OAuth grant, recreates the DB, restores it |
| `bun run db:backup -- --full` | `pg_dump` alongside the grant |
| `bun run db:generate` | New migration + guard against touching the queue schema |
| `bun scripts/sortify-recall.ts [--model]` | Sortify's held-out recall test |
| `cd engine && cargo test` | The engine's tests (need a Postgres in `DATABASE_URL`, see Deckhand's engine) |

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
cannot orphan one. The overview shows both halves under one range picker: where
they answer the same question (top artists, the calendar, the bump chart) one
card switches between hours played and recordings saved, and a card of its own
shows where they meet — how many saves were heard first, kept on first listen,
kept unheard or never played, and how much of the library has gone quiet.

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

![The library table filtered to liked songs, sortable and searchable](docs/screenshots/library-page.png)

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

**`/automations` fills a playlist instead of owning one.** An automation is a
set of source playlists and one destination, and it only ever *appends*: it
issues `POST /playlists/{id}/tracks` and nothing else — no `PUT`, no `DELETE`.
So the destination stays an ordinary playlist. Add to it in Spotify, reorder
it, delete from it, rename it, and the automation carries on around you. Its
description is written once, when it creates the playlist, and never touched
again; it can equally be pointed at a playlist you already keep by hand.

Which leaves the question an append-only design has to answer: what has
already been added? `automation_added_tracks` is the answer — every track the
automation has contributed, kept forever. A track in the ledger is never
offered again, so deleting a song from the destination makes it stay deleted:
the run asks "have I added this", not "is this still there". The ledger carries the canonical id
alongside the Spotify one, or a song added last week as a single would come
back this week as the album cut. Anything found already in the playlist at run
time is recorded rather than re-added, which is how a track you put there
yourself stops being offered.

**Spotify's API cannot see folders.** `GET /me/playlists` is flat and nothing
exposes the tree the desktop app draws, so a folder here is the set of
playlists you tick — which also means a source needs no folder at all. Any
playlist can feed any automation, including one pasted as a link that this
database has never ingested; it is fetched on demand, the same path `/track`
and `/album` use for an entity a page asks for.

Freshness costs one request per source per run: `GET /playlists/{id}` says
whether the snapshot moved, and only the sources that moved have their item
pages re-read. New sources are backfilled by default — the alternative, "only
tracks added from now on", records what the source already holds as seen
without pushing any of it, and applies at the moment each source is attached
rather than when the automation was created. Runs happen hourly, after every
completed sync, and inline when the button is pressed.

**`/dj` finds the next record.** The pool is every library recording
Deckhand has downloaded, with the tempo and key of the file itself (below).
Browse it by a Camelot wheel and a
tempo strip that each count under every filter but their own, pick a record
to start a set, and every suggestion after that is ranked against the last
track: how safe the key move is, how little pitching it takes, whether
Spotify's radio of the set plays it, then, lightly, whether you play it. Key
and tempo are gates as well as weights (±3/6/10%, harmonic or with the +2/+7
energy moves); the radio and play count only rank. Tempo is
matched with octaves folded, because thirty seconds of an 87 BPM record can
read as 174 and a DJ mixes across that anyway.

**Tempo and key come from the real files.** Spotify withdrew
`/audio-features`, so the numbers are Deckhand's: the engine analyses every
file it downloads into the music folder with
[rbxport](https://github.com/eliasfloreteng/rbxport), and where rekordbox on
the Mac has analysed the same file, uses rekordbox's numbers instead.
`deckhand.recordings` is one row per ISRC — the file, its state, `bpm`,
`camelot` and whose `analysis` it is — and the DJ tab, the track page and
Sortify join it to `canonical_tracks` on the ISRC. The engine owns that view,
and reads it itself to pick between two files of one recording, so both sides
always mean the same file. A recording that is not downloaded has no tempo or
key at all: an earlier version measured Deezer's 30-second preview of every
recording, and those numbers were deleted rather than kept as a fallback, since
a preview is not the record on the stick. How much of the library is
downloaded is on the dashboard.

Which keys may follow which is defined once, in TypeScript (`movesFrom` in
`utils/music.ts`), and handed to Postgres as a table — so the suggestions and
the set's transition labels cannot disagree. The set lives in the URL as
repeated `?s=`: adding is a link, back is undo.
Suggestions collapse to one per *song* (`song_title_key`), so the radio edit
and the extended mix are not both offered, nor either once the other is in
the set. "Save to Spotify" writes the set as a new private playlist, which is
also the way onto the DJ stick: Deckhand copies any playlist.

**The radio says what belongs in the set.** Key and tempo say whether two
records *can* be mixed, not whether they should: after a tech-house track, a
Pitbull single at the same key and tempo ranked first. Spotify withdrew every
API that knew better (recommendations, related artists, audio features), but
a song's radio (below) is still its judgement of what comes next. So the
radios of the set's last three tracks, weighted 1, ½ and ¼, feed the score
with 30% of it: a suggestion scores fully when a radio plays the recording or
another release of the song, and up to 60% of that when a radio plays its
artist. The same seed, ranked with and without it, goes from Pitbull, Lana
Del Rey and Florence + The Machine to Chris Lake, FISHER and Mau P. Radios are
cached in memory for six hours, since every track added reloads the page; the
page waits at most five seconds for them and ranks on whatever came in,
saying so, and `?radio=off` ranks without them.

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
reach. It reads the engine's `deckhand` tables too (the downloaded files,
their tempo and key, the downloads), but not the phones it notifies or the
download sources' passes. Statement-inspecting allowlists were not considered: they have to be
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

The one exception to read-only is `spotify_api`, which passes an arbitrary Web
API request through to the account with the stored token, for live state and
changes the archive cannot answer. It goes through the same `spotifyFetch` as
the sync, so it spends from the same rate-limit bucket, and it can do no more
than the app's granted scopes allow. Its description and the server
instructions tell the model to confirm with the user before anything
destructive.

```bash
claude mcp add --transport http spotidata http://127.0.0.1:5173/api/mcp
```

**`/api/sortify` is [Sortify](https://github.com/eliasfloreteng/sortify)'s
backend**, the iOS app that sorts liked songs into playlists one full-screen
card at a time. The app has no Spotify sign-in and no model key of its own: it
draws what these routes hand it and sends back what the user decided. Like
everything here they are unauthenticated, because the host is tailnet-only.

| Route | What it does |
|---|---|
| `GET /api/sortify` | The account, whether the grant covers playlist writes and playback (with the re-authorization link if not), the last sync, the model settings and spend |
| `POST /api/sortify/refresh` | An incremental sync, unless one ran in the last half hour, so a song liked in Spotify reaches the feed |
| `GET /api/sortify/feed?source=` | The songs to go through: `unsorted` (liked, in no eligible playlist, newest first), `liked`, or `playlist:<id>` — gzipped, with an ETag |
| `GET /api/sortify/playlists` | Every playlist, with `eligible`, the default `exclusion` and the user's `override` |
| `PUT /api/sortify/playlists/{id}/eligibility` | `{eligible}`: sort into it or not |
| `POST /api/sortify/playlists` | `{name, description, tracks, idea}`: a new private playlist |
| `POST`/`DELETE /api/sortify/playlists/{id}/tracks` | `{tracks}`: add the recordings not there yet / remove every copy of them |
| `GET /api/sortify/artists/{id}/tracks?source=` | Every liked song by an artist (plus the playlist being gone through), for bulk sorting |
| `POST`/`DELETE /api/sortify/suggestions` | The feed card's suggestions for `{tracks}`, asking the model about the uncached ones / forget them all |
| `GET`/`PUT /api/sortify/settings` | The three OpenRouter models |
| `GET /api/sortify/sort?min_plays=&limit=` | The sort queue: songs played at least `min_plays` times, not yet reviewed, best first, each with suggestions and what to tick |
| `POST /api/sortify/sort/judge` | `{songs}`: ask the model about these songs, answer with them updated |
| `POST /api/sortify/sort/apply` | `{rows: [{song, playlists}]}`: add, turn down the unticked suggestions, mark reviewed |
| `DELETE /api/sortify/sort/reviewed`, `…/sort/verdicts` | Bring the reviewed songs back / forget the model's verdicts |
| `GET /api/sortify/sort/playlists[/{id}]` | Every eligible playlist with how many songs wait for it / the best candidates for one |
| `POST /api/sortify/sort/playlists/{id}/judge`, `…/dismissals` | The model judges thirty candidates for one playlist / `{song}` "not here" |
| `GET`/`POST /api/sortify/sort/ideas`, `DELETE …/ideas/{id}` | Proposed new playlists for the songs that fit nowhere / propose more / dismiss one |
| `GET /api/sortify/player[/devices]` | Spotify Connect: what is playing, and where it could |
| `PUT /api/sortify/player/play\|pause\|resume\|seek` | `{track, position_ms, device}` |
| `GET /api/sortify/player/wake?redirect=` | The link that starts Spotify on the phone (below) |

Errors are JSON with a stable `error` code: `reauthorize` (a scope is
missing; `reauthorize_url` fixes it), `signed_out`, `rate_limited` (503 with
`Retry-After`), `no_device`, `model`.

**The playlists Sortify sorts into** are the owned ones, less three kinds left
out by default: monthly playlists ("Oktober", "Dreamy December - 2018") are a
record of what was on repeat, Spotify-made ones (Your Top Songs, Playlist in a
Bottle, Liked from Radio) are not the user's sorting, and one with nothing
added in two years is a snapshot rather than a playlist being filled. A
left-out playlist does not make a song "sorted" and is never suggested. Any
playlist can be switched in or out; `sortify_playlist_overrides` stores the
choice only where it differs from the default it was made against, so a
playlist that goes idle later still drops out on its own.

**Sortify's memory is keyed on the song, not the recording.**
`spotidata.sortify_song_key` hashes `song_title_key` — the title without
featured artists and remaster / radio-edit qualifiers — with the primary
artist's id, so the remaster, the radio edit and the feat. version share one
key: a "no" for one is a "no" for all, and a playlist holding one is never
offered another. It is built from names rather than from a canonical id, so a
regrouping cannot orphan the verdicts (`sortify_verdicts`), the turned-down
suggestions (`sortify_dismissals`) or the reviewed songs keyed on it.

**Suggestions are the data's match plus the model's verdict.** The data side
(`sortify/engine.ts`) profiles every eligible playlist — its artists, its
artists' Spotify genres TF-IDF weighted across the library, its release years
(and whether they are a rule: an era playlist), when its songs were first heard
— and scores each liked song against it: shared artists and genre similarity,
plus or minus for an era, and a lift where the playlist's name reads like one
of the song's genres, for playlists too young to have a profile. It is built in
one pass, about a second, and kept in memory until a sync lands or a write
moves it. The model (OpenRouter, `openai/gpt-6-luna` by default) gets the
playlist catalog — kept byte-identical between requests so the providers bill
it at the cache rate — and a page of songs with the data's matches as hints,
and rates each fit 1–3. A playlist it saw and passed over is marked down. Every
verdict is stored, so nothing is asked twice, and every request is logged with
its cost (`sortify_ai_requests`).

Spotify's artist genres are the only genre data left, and they earn their
place. On Sortify's held-out test — 80 liked songs that sit in playlists are
taken out of them, and each method has to find them again —
`bun scripts/sortify-recall.ts --model` measures recall within the top three:

| Method | Recall@3 | Was (MusicBrainz) |
|---|---|---|
| Data only, as the app ranks it | 0.59 | 0.55 |
| Data only, without artist genres | 0.56 | |
| `openai/gpt-6-luna` + data hints | 0.71 | 0.60 |
| `openai/gpt-6-luna` + data hints, without artist genres | 0.64 | |

Across six samples the genres add four to six points every time. The model run
spends about $0.03 for the 160 songs.

**A write lands in the mirror at once.** Adding to a playlist appends the rows
to `playlist_tracks` as soon as Spotify accepts them, so the feed never offers
a song that was just sorted. What it does not do is claim the playlist is
synced: `items_synced_snapshot_id` stays at what the last sync read, so the
next one sees Spotify's snapshot moved, re-reads that playlist and replaces the
rows with Spotify's own — picking up anything else changed in it meanwhile.

**Playback stays on the phone; control does not.** Sortify plays the song on
screen in the phone's Spotify app through Spotify Connect, driven from here
with the stored grant and the same rate-limit bucket as the sync, which needs
`user-read-playback-state` and `user-modify-playback-state`. A song is played
inside its album with an offset, because the iOS app accepts a bare track and
then plays nothing. When Spotify is not running on the phone there is no
device to play on, so `/player/wake` builds Spotify's app-based authorize link
for this app's client id: opening it starts Spotify, which registers as a
device, and bounces straight back to Sortify's URL scheme. That redirect
(`reelsforspotify://callback`) must be registered on the Spotify app; the code
it carries is thrown away.

**Song radio comes from the web player, not the Web API.** Since November
2024 the Web API hides every Spotify-owned playlist from an app like this one:
search returns `null` in their place, `GET /playlists/{id}` answers 404, and
nothing says which playlist is a song's radio anyway. Spotify's internal API
(`spclient`) knows both — `inspiredby-mix/v2/seed_to_playlist` names the radio,
`playlist/v2/playlist/{id}` lists its 50 tracks — and it accepts the anonymous
token the embed widget ships in its `__NEXT_DATA__`. So `spotify/web-player.ts`
scrapes that token (no cookie, no account) and the radio is the one anyone
would get, not one tuned to this account. The tracks are then filled in by the
ordinary `/tracks?ids=` (one request per 50, through the bucket) and marked
with what the library holds, matched on the ISRC so a different release of a
song you keep still counts. Nothing is stored; Spotify regenerates radios (the DJ tab keeps a six-hour in-memory cache).
It is at `/radio/<track id>` (linked from every track page), at
`/api/radio/<track id>` as JSON, as the MCP tool `song_radio`, and behind the
DJ tab's suggestions.

## Deckhand's engine

[Deckhand](https://github.com/eliasfloreteng/deckhand) keeps a DJ USB stick in
sync with a music folder, from an iPhone or a Mac. The engine is its server:
it watches the folder (`/home/pi/music` on the Pi, synced to the stick by
Syncthing), analyses new tracks with rbxport (or takes rekordbox's analysis
when the Mac sends it), downloads lossless copies of the tracks you ask for and
of the Spotify playlists you keep, and serves the library, the audio and the
analysis to the apps. It is `engine/`, a Cargo workspace: `server/` is the
binary (`deckhand-server`), `model/` the manifest the apps read, which
Deckhand's `crates/core` (the stick exporter) takes from this repository as a
git dependency.

It runs as the stack's second service, from the same Dockerfile
(`--target engine`), and keeps its state in the same Postgres, in a schema of
its own, `deckhand`, which it creates and migrates at startup
(`engine/server/migrations/`, sqlx). It runs every statement as the role
`deckhand` (`DECKHAND_DATABASE_ROLE`), which `db/sql/post/110_engine.sql`
creates and grants nothing of Spotidata's but two views. So the line between
the two is Postgres's to hold:

- **The engine reads Spotidata, read-only.** Every playlist and its tracks is
  already in `playlists` / `playlist_tracks`; the engine reads the ones you
  keep through `spotidata.engine_playlists` and
  `spotidata.engine_playlist_tracks` instead of keeping a copy. What it keeps
  is its own: which playlists are kept, which download got which recording,
  what keeping them did (activity), the `.m3u8` it wrote for each.
- **Spotidata reads the engine.** `deckhand.recordings` (above) for tempo,
  key and what is downloaded; the MCP role may read the engine's tables but
  its phones (`devices`) and `meta`, which holds the sources' passes.
- **Spotify only through Spotidata.** The engine has no Spotify sign-in. What
  needs Spotify goes through Spotidata's `/api/engine/*`, and so through
  `spotifyFetch` and the one rate limiter:

| Route | |
|---|---|
| `GET /api/engine/search?q=&limit=` | Spotify's catalog, for Get Music in the apps |
| `POST /api/engine/playlists/check` | `{ids, force}`: the check of the kept playlists, below |
| `PUT /api/engine/playlists/{id}` | Fetch a playlist (one kept by its link) into the tables, as a page fetches an entity |

### Routing

Both services answer on `spotidata.eliasf.se`. The engine's paths
(`/api/library`, `/api/music/…`, …) would collide with Spotidata's own, so it
lives under a prefix: Traefik sends `/deckhand/*` to the engine with the prefix
stripped (a `stripprefix` middleware, behind `tailnet-only@file` like the rest),
and the apps' server address is `https://spotidata.eliasf.se/deckhand`. The
engine itself serves from `/`; inside the stack Spotidata is
`http://spotidata:3000`.

### The engine's API

| Route | |
|---|---|
| `GET /api/health` | `ok` |
| `GET /api/library` | the manifest (gzip, with an ETag) |
| `GET /api/music/{name}`, `/api/blobs/{hash}` | a file of the folder (with ranges), an analysis or artwork blob (immutable) |
| `PUT /api/rekordbox` | a snapshot of rekordbox's library from the Mac (tar) |
| `GET /api/catalog/search?q=` | Spotify's catalog, with what the folder already holds marked |
| `GET`/`POST /api/downloads`, `PUT …/settings`, `POST …/{id}/retry`, `DELETE …/{id}` | the queue, sources and settings / ask for a track |
| `POST /api/imports?name=` | an audio file from the phone, as the body |
| `POST /api/challenges/{id}`, `POST /api/devices` | a solved check's pass / a phone to notify |
| `GET`/`PUT /api/spotify`, `POST …/check`, `GET …/activity` | the playlists and the checks, pause, check now, what they did |
| `POST /api/spotify/playlists`, `GET`/`PUT …/{id}`, `POST …/{id}/check` | keep one by its link / its tracks, keep or stop / read it again |

### Downloads

Get Music searches Spotify's catalog (`/api/catalog/search`), so a result
carries the library's own ids and ISRCs, and marks what the folder holds (by
ISRC tag, else title and artist). Asking for a track (`POST /api/downloads`)
queues it, and the engine:

1. finds the recording on Deezer by its ISRC, for the Deezer id the Deezer
   sources fetch by and the tags and 1000 px cover it files the track with;
2. asks every source at once whether it has the recording (by ISRC, else by
   title, artist and duration), then tries them best first;
3. streams the file, dropping a mirror that stalls or crawls while another
   could do better, and falls back to the next mirror and source;
4. checks that it is lossless and the right length (no previews), decrypts
   where needed, writes clean tags and the cover;
5. files it as `Title - Artists.flac`, never over an existing file.

| Source | Via | Notes |
|---|---|---|
| Amazon Music | Antra mirror | FLAC in encrypted MP4; needs ffmpeg |
| Deezer | Antra mirror | Deezer CDN, Blowfish stripes decrypted in Rust |
| Tidal | Antra mirror | relayed FLAC |
| Qobuz | Antra mirror | relayed FLAC; often region-locked |
| Monochrome | tracks.monochrome.st | plain FLAC, rate-limited |
| Tidal (hifi-api) | community instances | list read from Monochrome's `instances.json`, plus `DECKHAND_HIFI_INSTANCES` |
| Tidal, Qobuz, Deezer | flacdownloader.com | behind a Cloudflare Turnstile check solved in the app |

The sources are free community mirrors that come and go. Each is a `Source` in
`engine/server/src/downloads/sources/`; every lookup, download and half-hourly
probe updates a running average of each mirror's reliability, latency and
speed (`health.rs`), and the next download tries the lowest expected time
first. A mirror that fails twice (once, if it has never worked) or answers
429 rests, 1 min doubling to an hour. `DECKHAND_SOURCES_OFF=qobuz,hifi` turns
sources off. flacdownloader hands out each file for a token from a solved
Turnstile: a download with nothing left but that source waits, the engine
sends a push (APNs, the key in `secrets/apns.p8`), and the app solves the
check on the site's own origin and posts the pass to `/api/challenges/…`.

**The web app manages the downloads too.** Every page that lists tracks (a
track, an album, a playlist, the library, an artist's top tracks, a song
radio) shows where each stands — in the folder, on the way, failed — with a
button to get it, try again or stop, and a list's missing tracks can be asked
for at once. A playlist page keeps or stops keeping the playlist on the stick,
the library filters on what is downloaded, and `/downloads` is the engine's
own view: the queue with live progress, the failures and the sources each
tried, the kept playlists and their checks, the sources' health, the AIFF
setting, and Get Music over Spotify's catalog.

Where a track stands is read from the engine's tables (`deckhand.recordings`
by ISRC, then its newest download by ISRC or Spotify id), so a playlist of a
thousand tracks is one query and the pages still load while the engine is
down; only the bytes so far come from the engine, while something downloads.
Everything that changes something goes through the engine's API, at
`DECKHAND_URL` (`http://engine:8080` in the stack), since the schema is the
engine's to write:

| Route | |
|---|---|
| `POST /api/downloads` | `{tracks: [spotify id]}`: queue what the folder lacks and nothing is getting |
| `POST /api/downloads/status` | `{tracks: [{id, isrc?}]}`: where each stands, for the buttons to follow |
| `POST /api/downloads/{id}/retry`, `DELETE /api/downloads/{id}` | try again / stop, or forget a finished one |
| `GET /api/downloads/queue` | the engine's queue, for `/downloads` to follow |
| `PUT /api/downloads/playlists/{id}` | `{kept}`: keep a playlist on the stick, or stop |

Files you already have go in from the apps (`POST /api/imports`): checked to
play on the decks (FLAC, AIFF, WAV, MP3, M4A), skipped when the folder holds
the same file or ISRC, and filed like a download. Settings › Downloads ›
Convert to AIFF files FLAC as AIFF from then on, decoded in Rust to the same
samples, with the tags as an ID3 chunk.

The engine only ever adds audio to the folder: a download is staged in
`/data/downloads`, copied in as a Syncthing temporary and hard-linked to its
name, which fails rather than replace a file. The only files it rewrites or
deletes are the `.m3u8` of the playlists it keeps.

### Spotify playlists

The apps list the account's playlists (from `spotidata.engine_playlists`) and
you pick the ones to keep; any other playlist is kept by pasting its link,
which has Spotidata fetch it into its tables (`PUT /api/engine/playlists/{id}`,
through the on-demand queue a page uses). Every ten minutes, and when the app
asks (`POST /api/spotify/check`), the engine has Spotidata check the kept ones
(`POST /api/engine/playlists/check`): the account's listing (one request per
50 playlists), one request for each kept playlist the account does not list,
and the item pages of only those whose snapshot moved — the sync's own
snapshot gate, so a quiet check is a handful of requests and a track added in
the afternoon is on the stick that evening. Then, against the folder:

1. each track is found by ISRC, else by title and first artist, else by the
   download that got it. A match by name is remembered (`spotify_found`):
   Spotify names some tracks differently by endpoint, and the name Spotidata
   holds can change under a file that was found by it;
2. a track the folder lacks is queued as a download, as Spotify knows it; a
   failed one is tried again after a day, one you stopped is left alone;
3. the playlist is written as `<Name>.m3u8` in Spotify's order with the
   tracks the folder holds, and rewritten as downloads land.

Removing a track on Spotify takes it out of the playlist file, never out of
the folder. A playlist you stop keeping loses its file, unless it was edited
since. The checks can be paused from the app; what they do is kept as
activity (the last 500 entries).

### Develop

```sh
docker run -d --name engine-pg -e POSTGRES_PASSWORD=pg -p 127.0.0.1:55432:5432 postgres:18-trixie
cd engine
DATABASE_URL=postgres://postgres:pg@127.0.0.1:55432/postgres cargo test
cargo clippy --all-targets
```

The tests run against a real Postgres: `DATABASE_URL` names one they may
create throwaway databases in (`#[sqlx::test]`), and they stand in for
Spotidata's two views with tables of their own. A local engine against the
dev database (after `bun run db:migrate`, which creates the role):

```sh
DECKHAND_MUSIC=/some/music DECKHAND_DATA=/tmp/dh DECKHAND_BIND=0.0.0.0:8797 \
DECKHAND_DATABASE_URL=postgres://spotidata:spotidata@127.0.0.1:5432/spotidata DECKHAND_DATABASE_ROLE=deckhand \
DECKHAND_SPOTIDATA=http://127.0.0.1:5173 cargo run -p deckhand-server
```

Against the real account, only read: don't keep playlists from a test engine,
and download only into a scratch music folder.

The engine used to keep its state in SQLite (`deckhand.db` in its data dir).
`deckhand-server import-sqlite <deckhand.db>` copies it once into an empty
schema, converting the types, and checks the blobs the rows name against
`DECKHAND_DATA/blobs`; it keeps nothing if a row does not convert
(`--keep-going` keeps the rest). Of the Spotify playlists it copies only the
engine's own state: Spotidata already has the playlists.

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
                   refresh_album_groups, refresh_plays, mcp_role, sortify,
                   engine (the deckhand role and the engine's views)
src/lib/server/    db/ spotify/ ingest/ import/ queue/ stats/ entities/
                   playlists/ mcp/ sortify/ engine/ (what the engine asks of Spotidata)
engine/            Deckhand's engine, a Cargo workspace: server/ (the binary,
                   its migrations/) and model/ (the manifest the apps read)
src/lib/charts/    d3 computes, Svelte renders — no d3-selection
src/routes/        overview, entity pages, /history/{log,import}, /dj, /downloads, /automations, /sync,
                   /settings, /api
scripts/           probe-api, apply-sql, check-migration, check-sql-conventions,
                   backup, restore-auth, spike-worker
```

Nothing under `src/lib/server` may import `$lib`, `$env/*` or `Bun.*`: the same
modules run under Bun (SvelteKit) and plain Node (`bun run worker`), so
`WORKER_MODE=external` is a one-line change.

## Not built yet

Beatport enrichment; Telegram re-auth alerts.
