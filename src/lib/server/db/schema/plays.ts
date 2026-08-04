import { bigint, boolean, check, index, integer, jsonb, text, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { table, ts, tsNow } from './_shared.ts';
import { canonicalTracks, spotifyTracks } from './catalog.ts';

export type PlaySource = 'extended' | 'recent';
export type PlayItemKind = 'track' | 'episode' | 'audiobook' | 'unknown';

/**
 * One row per stream event — the thing the library tables cannot tell you:
 * not what you kept, but what you actually listened to.
 *
 * Two sources feed it. The extended streaming history export is the whole
 * record back to the first play and carries how long each stream lasted and
 * why it started and ended; `/me/player/recently-played` is a 50-item window
 * polled on a cron, which keeps the log current between exports but knows
 * neither `ms_played` nor `reason_*`.
 *
 * KEYS ON `spotify_tracks.id`, never on the canonical id — a regrouping must
 * never orphan a play. `trackId` is nullable and stays so until the resolve
 * phase has fetched the track: most plays are of recordings that were never
 * saved, and the log is worth keeping whether or not the catalog caught up.
 * `itemUri` is therefore the durable identity here, and podcast episodes and
 * audiobook chapters have nothing else at all.
 */
export const plays = table(
	'plays',
	{
		id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
		/**
		 * When the stream ENDED, truncated to the second. Both sources report an
		 * end time; the export gives whole seconds, so the API's milliseconds are
		 * dropped on the way in to keep the two comparable — see `plays_event_uq`.
		 */
		playedAt: ts().notNull(),
		/** NULL means unknown, which is every row that came from the API. */
		msPlayed: integer(),
		itemKind: text().$type<PlayItemKind>().notNull().default('track'),
		itemUri: text().notNull(),
		trackId: text().references(() => spotifyTracks.id, { onDelete: 'set null' }),
		/**
		 * When the resolve phase last asked Spotify for this URI.
		 *
		 * Plenty of played tracks are gone for good — regional pulls, deleted
		 * uploads — and without a record of having asked, every sync would spend
		 * the same few hundred requests re-discovering that. Clearing this column
		 * is how the "retry unresolved" button works.
		 */
		resolveAttemptedAt: ts(),

		// The export's own labels. Kept verbatim rather than looked up: a track
		// pulled from Spotify since, or never fetched at all, still reads as the
		// thing you played, under the name it had at the time.
		trackName: text(),
		artistName: text(),
		albumName: text(),
		episodeName: text(),
		showName: text(),

		platform: text(),
		connCountry: text(),
		reasonStart: text(),
		reasonEnd: text(),
		shuffle: boolean(),
		skipped: boolean(),
		offline: boolean(),
		incognito: boolean(),

		source: text().$type<PlaySource>().notNull(),
		importId: bigint({ mode: 'number' }).references(() => playImports.id, {
			onDelete: 'set null'
		}),
		ingestedAt: tsNow()
	},
	(t) => [
		check('plays_source', sql`${t.source} in ('extended','recent')`),
		check('plays_item_kind', sql`${t.itemKind} in ('track','episode','audiobook','unknown')`),
		/**
		 * Re-importing the same export must not double the history, and the export
		 * itself repeats rows: 565 (uri, second) pairs occur twice in this account's
		 * 167k plays. Half of those are byte-identical — Spotify's own log emitting
		 * a stream twice — and the other half are two genuinely different streams
		 * ending in the same second, which happens whenever you skip through a
		 * queue. Including `ms_played` in the key is what tells those apart: equal
		 * durations collapse, different ones both survive.
		 *
		 * NULLS NOT DISTINCT matters for the API source, whose `ms_played` is
		 * always NULL — under the default rule every poll would insert afresh.
		 */
		unique('plays_event_uq').on(t.playedAt, t.itemUri, t.msPlayed).nullsNotDistinct(),
		index('plays_played_ix').on(sql`${t.playedAt} desc`),
		index('plays_track_ix').on(t.trackId, t.playedAt),
		index('plays_uri_ix').on(t.itemUri, t.playedAt),
		// Drives the resolve phase seeder: track plays we have no catalog row for
		// and have not already failed to fetch.
		index('plays_unresolved_ix')
			.on(t.itemUri)
			.where(
				sql`${t.trackId} is null and ${t.itemKind} = 'track' and ${t.resolveAttemptedAt} is null`
			)
	]
);

/** One row per archive handed to the importer; the /history/import progress bar. */
export const playImports = table(
	'play_imports',
	{
		id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
		/** Display name — the uploaded filename or the folder that was pointed at. */
		label: text().notNull(),
		/** Where the bytes actually are while the job runs. */
		path: text().notNull(),
		kind: text().$type<'zip' | 'folder'>().notNull(),
		sizeBytes: bigint({ mode: 'number' }),
		/** True when the importer owns the file and should delete it when done. */
		temporary: boolean().notNull().default(false),
		status: text().notNull().default('queued'),
		files: integer().notNull().default(0),
		filesDone: integer().notNull().default(0),
		rowsRead: bigint({ mode: 'number' }).notNull().default(0),
		playsInserted: bigint({ mode: 'number' }).notNull().default(0),
		duplicates: bigint({ mode: 'number' }).notNull().default(0),
		firstPlayedAt: ts(),
		lastPlayedAt: ts(),
		error: text(),
		meta: jsonb().notNull().default(sql`'{}'::jsonb`),
		createdAt: tsNow(),
		startedAt: ts(),
		finishedAt: ts()
	},
	(t) => [
		check('play_imports_kind', sql`${t.kind} in ('zip','folder')`),
		check(
			'play_imports_status',
			sql`${t.status} in ('queued','running','completed','failed','cancelled')`
		),
		index('play_imports_created_ix').on(sql`${t.createdAt} desc`)
	]
);

/**
 * DERIVED by `spotidata.refresh_play_stats()`. One row per recording ever
 * played, which is a wider set than `library_canonical` — plenty of what you
 * listen to was never saved.
 *
 * It exists so a list page can sort 8.8k recordings by play count without
 * grouping 167k events per request; every time-ranged chart still reads
 * `plays` directly, since a rollup cannot be re-cut by the range picker.
 */
export const canonicalPlayStats = table(
	'canonical_play_stats',
	{
		canonicalTrackId: text()
			.primaryKey()
			.references(() => canonicalTracks.id, { onDelete: 'cascade' }),
		plays: integer().notNull().default(0),
		/** Streams that ran past `PLAY_COUNTS_MS`; the honest "listened to" count. */
		completedPlays: integer().notNull().default(0),
		skips: integer().notNull().default(0),
		msPlayed: bigint({ mode: 'number' }).notNull().default(0),
		firstPlayedAt: ts(),
		lastPlayedAt: ts(),
		refreshedAt: tsNow()
	},
	(t) => [
		index('cps_plays_ix').on(sql`${t.plays} desc`),
		index('cps_ms_ix').on(sql`${t.msPlayed} desc`),
		index('cps_last_ix').on(sql`${t.lastPlayedAt} desc`)
	]
);
