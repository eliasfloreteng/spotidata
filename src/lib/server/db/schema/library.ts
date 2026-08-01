import { boolean, index, integer, primaryKey, smallint, text } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { table, ts, tsNow, externalUrls } from './_shared.ts';
import { albums, artists, canonicalTracks, spotifyTracks } from './catalog.ts';
import { spotifyUsers } from './auth.ts';

// ------------------------------------------------------------ saved facts

export const savedTracks = table(
	'saved_tracks',
	{
		trackId: text()
			.primaryKey()
			.references(() => spotifyTracks.id, { onDelete: 'cascade' }),
		addedAt: ts().notNull(),
		/** Set when a reconciliation pass finds the track gone from Spotify. */
		removedAt: ts()
	},
	(t) => [index('saved_tracks_added_ix').on(t.addedAt).where(sql`${t.removedAt} is null`)]
);

export const savedAlbums = table('saved_albums', {
	albumId: text()
		.primaryKey()
		.references(() => albums.id, { onDelete: 'cascade' }),
	addedAt: ts().notNull(),
	removedAt: ts()
});

export const followedArtists = table('followed_artists', {
	artistId: text()
		.primaryKey()
		.references(() => artists.id, { onDelete: 'cascade' }),
	firstSeenAt: tsNow(),
	removedAt: ts()
});

// -------------------------------------------------------------- playlists

export const playlists = table(
	'playlists',
	{
		id: text().primaryKey(),
		name: text().notNull(),
		description: text(),
		ownerId: text().references(() => spotifyUsers.id),
		/** ownerId === the `isMe` user. Defines what counts as "the library". */
		isOwned: boolean().notNull().default(false),
		collaborative: boolean().notNull().default(false),
		public: boolean(),
		snapshotId: text().notNull(),
		totalTracks: integer(),
		href: text(),
		uri: text(),
		externalUrls: externalUrls(),
		/**
		 * The snapshot whose items are currently stored. Incremental syncs skip
		 * a playlist entirely while this matches the live `snapshotId`, which is
		 * what keeps a resync at a few hundred requests instead of ~425.
		 */
		itemsSyncedSnapshotId: text(),
		itemsSyncedAt: ts(),
		firstSeenAt: tsNow(),
		removedAt: ts(),
		updatedAt: tsNow()
	},
	(t) => [index('playlists_owned_ix').on(t.isOwned).where(sql`${t.removedAt} is null`)]
);

export const playlistImages = table(
	'playlist_images',
	{
		playlistId: text()
			.notNull()
			.references(() => playlists.id, { onDelete: 'cascade' }),
		position: smallint().notNull(),
		url: text().notNull(),
		width: integer(),
		height: integer()
	},
	(t) => [primaryKey({ columns: [t.playlistId, t.position] })]
);

/**
 * NOTE the primary key is (playlistId, position), NOT (playlistId, trackId).
 * The same track may legitimately appear several times in one playlist; the
 * intuitive key silently collapses those and understates playlist sizes.
 *
 * `trackId` is nullable: playlist items can be local files or episodes, and
 * Spotify returns `track: null` for items that have become unavailable.
 */
export const playlistTracks = table(
	'playlist_tracks',
	{
		playlistId: text()
			.notNull()
			.references(() => playlists.id, { onDelete: 'cascade' }),
		position: integer().notNull(),
		trackId: text().references(() => spotifyTracks.id),
		addedAt: ts(),
		addedById: text(),
		isLocal: boolean().notNull().default(false),
		/** Local files and episodes have no catalog row; keep their label anyway. */
		localName: text(),
		localArtist: text()
	},
	(t) => [
		primaryKey({ columns: [t.playlistId, t.position] }),
		index('playlist_tracks_track_ix').on(t.trackId),
		index('playlist_tracks_added_ix').on(t.addedAt)
	]
);

// ---------------------------------------------------------------- derived

/**
 * DERIVED by `spotidata.refresh_library()`. The library is defined as liked
 * songs ∪ tracks in playlists the user owns.
 */
export const libraryTracks = table('library_tracks', {
	trackId: text()
		.primaryKey()
		.references(() => spotifyTracks.id, { onDelete: 'cascade' }),
	viaLiked: boolean().notNull(),
	viaOwnedPlaylist: boolean().notNull(),
	likedAt: ts(),
	firstAddedAt: ts().notNull(),
	ownedPlaylistCount: integer().notNull().default(0)
});

/**
 * DERIVED. ~8,788 rows, one per canonical recording in the library. This is
 * the table nearly every chart reads; `firstAddedAt` is the MIN across all
 * copies and all sources, so the UI must say "first added".
 */
export const libraryCanonical = table(
	'library_canonical',
	{
		canonicalTrackId: text()
			.primaryKey()
			.references(() => canonicalTracks.id, { onDelete: 'cascade' }),
		firstAddedAt: ts().notNull(),
		latestAddedAt: ts().notNull(),
		liked: boolean().notNull(),
		copyCountInLibrary: integer().notNull(),
		ownedPlaylistCount: integer().notNull(),
		durationMs: integer().notNull(),
		primaryArtistId: text(),
		primaryAlbumId: text(),
		explicit: boolean().notNull()
	},
	(t) => [
		index('library_canonical_added_ix').on(t.firstAddedAt),
		index('library_canonical_artist_ix').on(t.primaryArtistId),
		index('library_canonical_album_ix').on(t.primaryAlbumId)
	]
);
