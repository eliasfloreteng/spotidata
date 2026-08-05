import { features, tableInventory } from './schema.ts';

/**
 * What an MCP client is told before it writes its first query.
 *
 * These are the rules that make an answer right rather than merely plausible.
 * Every one of them is a mistake this schema actively invites: counting
 * `spotify_tracks` overstates the library by 19%, a UTC date bucket moves an
 * evening save to the next day, a compilation outranks the albums the library
 * is built from. A model that has not been told will get all three wrong and
 * will sound completely confident doing it.
 */

/** The condensed form, repeated on the `query` tool for clients that drop instructions. */
export const KEY_RULES = `Rules that decide whether an answer is right:
- A track is an ISRC. Count and group recordings via canonical_tracks / the
  canonical_track_id columns, NEVER raw spotify_tracks rows (~19% duplicates).
- "The library" is library_canonical: liked songs plus tracks in playlists the
  user owns. Playlists merely followed are stored but are not the library.
- Exclude compilations from album statistics
  (albums.album_type is distinct from 'compilation'); a NULL type means
  un-hydrated, not compilation.
- Bucket dates AT TIME ZONE the user's timezone, never in UTC.
- Filter removed_at is null on saved_tracks, saved_albums, followed_artists
  and playlists unless the question is about removals.
- Genres, BPM and musical key are MusicBrainz/AcousticBrainz enrichment, read
  through spotidata.track_enrichment / artist_enrichment / album_enrichment.
  Coverage is partial by nature — a NULL means "not known", never zero.
Call describe_schema for columns; call get_business_rules for the full version.`;

function coreRules(
	timezone: string,
	plays: boolean,
	playStats: boolean,
	enrichment: boolean
): string {
	return `# Spotidata

A single-user archive of one Spotify account in Postgres: the catalog, the
library, the playlists${plays ? ', and the listening history' : ''}. This endpoint runs read-only SQL
against it. Read these rules before writing a query — most of them exist
because the obvious query returns a confidently wrong number.

## 1. A track is an ISRC, not a Spotify id

\`spotify_tracks\` is one row per Spotify catalog id. The same recording appears
under many of them — album cut, single, deluxe edition, per-market release —
and this library runs about 19% duplication, with one recording seen under 14
distinct ids.

\`canonical_tracks\` is one row per *recording*, keyed \`isrc:<ISRC>\` (99.5%) or
\`fb:<hash>\` for the few tracks Spotify gives no ISRC. **Count, rank, group and
deduplicate on the canonical id.** Reach it via
\`spotify_tracks.canonical_track_id -> canonical_tracks.id\`.

Counting \`spotify_tracks\` directly is the single most likely way to be wrong
here, and the number it produces looks entirely reasonable.

## 2. The library is \`library_canonical\`

Start there for anything phrased as "my music". One row per recording in the
library, precomputed: \`first_added_at\`, \`liked\`, \`duration_ms\`,
\`primary_artist_id\`, \`primary_album_id\`, \`copy_count_in_library\`.

The library is defined as **liked songs ∪ tracks in playlists the user owns**.
Playlists the user merely follows are ingested in full and are *not* part of it
— join \`playlists.is_owned\` when that distinction matters. \`spotify_tracks\`
holds the whole ingested catalog (~70k rows, most of it other people's
playlists); do not mistake it for the user's music.

\`first_added_at\` is the MIN across every copy and every source, so word results
as "first added", not "added".

## 3. An album is its track list

\`album_groups\` collapses editions the way \`canonical_tracks\` collapses tracks:
two albums are one release when they carry the same canonical tracks, ignoring
order. Titles are never compared. Join \`albums.album_group_id\`, and prefer the
group for "how many albums" questions.

For album statistics **exclude compilations**:
\`albums.album_type is distinct from 'compilation'\`. A 40-track greatest-hits
package or a label sampler otherwise outranks the records the library is
actually built from, and those recordings are already counted on their original
album. A NULL \`album_type\` is an album not yet fetched in full — keep it.

## 4. Derived tables are rebuilt, never edited

\`canonical_tracks\`, \`canonical_track_artists\`, \`album_groups\`,
\`library_tracks\`, \`library_canonical\`${playStats ? ', `canonical_play_stats`' : ''} are recomputed
from scratch by \`spotidata.refresh_*()\`. They hold zero user data by design, so
a regrouping can never orphan anything. Anything user-authored keys on
\`spotify_tracks.id\`.

Practical consequence: a canonical id is stable in meaning but not guaranteed
stable across a refresh. Do not store one; resolve it each time.

## 5. Listening history

${
	plays
		? `\`plays\` is one row per stream event, from the extended-history export and
from \`/me/player/recently-played\`. It keys on \`spotify_tracks.id\` (nullable —
plenty of plays are of recordings never saved, and the id resolves later), so
roll up through \`spotify_tracks.canonical_track_id\` to count a recording rather
than a release. \`ms_played\` is NULL for everything the API poller wrote — that
endpoint reports no duration — so **sum \`coalesce(ms_played, estimated_ms)\`**,
never \`ms_played\` alone: \`estimated_ms\` is that row's duration inferred from
the gap back to the previous play, and it is NULL only where a break makes even
that impossible. A stream counts as really listened to past 30s
(\`spotidata.play_completion_ms()\`).
${playStats ? '`canonical_play_stats` is the precomputed per-recording rollup — use it unless the question needs a time range.\n' : ''}
What was *played* and what was *saved* are different questions. \`plays\` covers
listening; \`library_canonical\` covers keeping.`
		: `**There is none.** No plays/streams table exists in this database, so
"most played", "top tracks", "minutes listened" and "recently listened" are
NOT answerable — say so rather than substituting something else. What this
archive knows is what was *saved* and *when*.

In particular \`popularity\` is Spotify's global 0-100 score for the track, not
a measure of this user's listening.`
}

## 6. Soft deletes

\`saved_tracks\`, \`saved_albums\`, \`followed_artists\` and \`playlists\` mark
disappearances with \`removed_at\` instead of deleting the row. **Filter
\`removed_at is null\`** unless the question is specifically about what was
removed.

## 7. Dates

Bucket by local time: \`at time zone '${timezone}'\` (the user's setting,
\`settings['ui.timezone']\`). A UTC bucket files a late-evening save under the
next day, and the library spans years of them.

Release dates from Spotify are ragged strings — "1998", "1998-03",
"1998-03-14". Use \`albums.release_date_start\` (a real \`date\`, parsed from that)
and \`canonical_tracks.earliest_release_date\` for anything ordered or bucketed.

## 8. Artists

\`canonical_track_artists\` is the *union* of credits across every copy of a
recording — one copy titled "Calabria" and another "Calabria (feat. Lujavo)"
share an ISRC but not a credit list, and the union keeps the featured artist's
page complete. For exactly one artist per track, filter
\`on_representative and position = 0\`, or just use the precomputed
\`library_canonical.primary_artist_id\`.

Genres belong to artists (\`artist_genres\`), not to tracks; Spotify no longer
returns track-level genres.${
		enrichment
			? ' MusicBrainz does — see rule 10, which is the better source for both.'
			: ''
	}

\`spotidata.track_genres\` puts both on the track: one row per
\`(canonical_track_id, genre, source)\`, where \`source\` is 'recording' (a
MusicBrainz tag, precise) or 'artist' (Spotify's genres for a credited artist,
broader). Use it for "tracks in genre X" — but filter or group by \`source\`,
because the two vocabularies are not the same one ("synth-pop" against
"swedish pop") and a track counted under both is still one track.

## 9. Incomplete rows are normal

\`detail_level = 'simplified'\` means the row was built from an object nested
inside another response and lacks \`isrc\`, \`popularity\` and genres. It is not an
error and not a data-quality problem worth reporting; exclude those rows when a
query depends on those columns.

## 10. MusicBrainz & AcousticBrainz${enrichment ? '' : ' (not populated)'}

${
	enrichment
		? `Genres, BPM, musical key, artist origins and release labels come from
MusicBrainz, joined to this catalog by **ISRC** — the one identifier the two
share. Read them through the views, which own the join path:

- \`spotidata.track_enrichment\` — keyed \`canonical_track_id\`. \`genres\` (a
  \`text[]\`, MusicBrainz tags filtered to its curated genre list), \`bpm\`,
  \`key_key\`/\`key_scale\`, and the 0–1 classifier probabilities
  (\`danceable\`, \`happy\`, \`sad\`, \`party\`, \`relaxed\`, \`aggressive\`,
  \`acoustic\`, \`electronic\`, \`instrumental\`).
- \`spotidata.artist_enrichment\` — keyed \`artist_id\` (the Spotify id).
  \`country\`, \`area_name\`, \`begin_area_name\` (where they are *from*),
  \`begin_date\`/\`end_date\`, \`type\` ('Person' | 'Group' | …), \`genres\`.
- \`spotidata.album_enrichment\` — keyed \`album_id\`. \`label_name\`,
  \`barcode\`, \`primary_type\`/\`secondary_types\`, \`genres\`.

**Coverage is partial and that is normal.** The crawl runs at one request per
second for hours, and AcousticBrainz stopped accepting submissions in 2022, so
roughly half of any library has no BPM at all. Treat a NULL as "not looked up
or not known", never as zero, and say what fraction an answer is based on when
it matters — \`spotidata.enrichment_coverage\` gives the per-stage totals.

The mood and genre classifiers are two-class models run over the audio, so a
track can score high on both \`happy\` and \`sad\`. They are evidence, not
verdicts; do not sum them into a profile.`
		: `The tables exist (\`isrc_recordings\`, \`mb_recordings\`, \`audio_features\`,
\`mb_tags\`, …) but nothing has been crawled yet, so there are no genres, no
BPM and no keys to query. Say so rather than returning empty results as if
they were an answer.`
}

## 11. Text search

pg_trgm is installed, with GIN trigram indexes on \`artists.name\`,
\`albums.name\`, \`spotify_tracks.name\` and \`canonical_tracks.title\`. Use
\`name ilike '%…%'\` or \`similarity(name, '…') > 0.3\` — both use the index.
\`spotidata.norm_title(text)\` strips diacritics, "(feat. …)" and
"- Remastered"-style suffixes if you need to match titles across editions.

## Conventions

Ignore the operational tables (\`sync_*\`, \`rate_limiter\`, \`api_call_stats\`,
\`ingest_raw\`, \`play_imports\`, \`graphile_worker.*\`) unless asked about the sync
itself. \`ingest_raw\` holds ~300 MB of verbatim API payloads — never
\`select *\` from it. The OAuth tables are not readable at all.

Unqualified names resolve in \`public\`. A selected \`timestamptz\` comes back as a
UTC ISO string, so any conversion to local time has to happen in the SQL — see
rule 7 — and a value you read back is not in the user's day.`;
}

/** The `instructions` field of the initialize result. */
export async function serverInstructions(timezone: string): Promise<string> {
	const { plays, playStats, enrichment } = await features();
	const rules = coreRules(timezone, plays, playStats, enrichment);

	try {
		return `${rules}\n\n## Tables\n\n${await tableInventory()}\n\nCall describe_schema for columns, types and constraints.`;
	} catch {
		// The rules are worth having even when the catalog read fails.
		return rules;
	}
}

/** Same text, as a tool — clients that ignore `instructions` can still ask. */
export async function businessRules(timezone: string): Promise<string> {
	const { plays, playStats, enrichment } = await features();
	return coreRules(timezone, plays, playStats, enrichment);
}
