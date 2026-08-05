import { boolean, check, index, integer, primaryKey, text } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { table, ts, tsNow } from './_shared.ts';

/**
 * Genre collections: a saved set of genres, and the Spotify playlist it keeps
 * in sync.
 *
 * This is the only user-authored data in the schema, which sets two rules.
 * It keys on nothing derived — genres are text, and the tracks are recomputed
 * on every push rather than stored — so a `refresh_canonical_tracks()` or a
 * re-enrichment can change what a collection *contains* but can never orphan
 * it. And the collection is the source of truth for the playlist, not the
 * other way round: Spotify holds a copy, we hold the definition.
 *
 * A selection also has to live here rather than in the URL. Forty genres of
 * `?g=` is several kilobytes of query string, which browsers and proxies
 * quietly truncate; an id in the path has no such ceiling.
 */
export const genreCollections = table(
	'genre_collections',
	{
		/** A slug minted from the name at creation, then immutable — renaming must not break a link. */
		id: text().primaryKey(),
		name: text().notNull(),
		description: text(),
		/** 'any' unions the genres; 'all' intersects them. */
		match: text().$type<'any' | 'all'>().notNull().default('any'),
		/** Track order pushed to Spotify; one of `COLLECTION_SORTS`. */
		sort: text().notNull().default('added'),
		/** Spotify's own ceiling is 10,000; this is the collection's. */
		trackLimit: integer().notNull().default(500),

		/** Null until the playlist has been created; a plain id, deliberately not a FK. */
		spotifyPlaylistId: text(),
		/**
		 * No FK to `playlists`: that table is a mirror of what the *sync* has
		 * seen, and a playlist created here exists on Spotify for hours before
		 * the next sync ingests it. A constraint would make the write path
		 * depend on the read path having run.
		 */
		playlistPublic: boolean().notNull().default(false),
		/** Whether the background job rewrites the playlist as the library changes. */
		autoSync: boolean().notNull().default(true),

		/**
		 * md5 of the pushed track ids, in order. A resync that computes the same
		 * list writes nothing — which matters because the alternative is
		 * rewriting a 500-track playlist every hour for no reason.
		 */
		syncedFingerprint: text(),
		/**
		 * Spotify's snapshot at the moment we last wrote. If it has moved since,
		 * somebody edited the playlist by hand and the fingerprint alone would
		 * wrongly conclude there is nothing to do.
		 */
		syncedSnapshotId: text(),
		syncedTrackCount: integer().notNull().default(0),
		lastSyncedAt: ts(),
		lastSyncError: text(),

		createdAt: tsNow(),
		updatedAt: tsNow()
	},
	(t) => [
		check('genre_collections_match', sql`${t.match} in ('any','all')`),
		check('genre_collections_limit', sql`${t.trackLimit} between 1 and 10000`),
		index('genre_collections_autosync_ix').on(t.autoSync).where(sql`${t.autoSync}`)
	]
);

export const genreCollectionGenres = table(
	'genre_collection_genres',
	{
		collectionId: text()
			.notNull()
			.references(() => genreCollections.id, { onDelete: 'cascade' }),
		/**
		 * A MusicBrainz genre name, free text on purpose. `mb_genres` is fetched
		 * from MusicBrainz and rebuilt wholesale, so a foreign key would let a
		 * vocabulary refresh delete part of somebody's playlist.
		 */
		genre: text().notNull(),
		addedAt: tsNow()
	},
	(t) => [primaryKey({ columns: [t.collectionId, t.genre] }), index('gcg_genre_ix').on(t.genre)]
);
