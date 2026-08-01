import {
	boolean,
	check,
	date,
	index,
	integer,
	jsonb,
	primaryKey,
	smallint,
	text
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { table, ts, tsNow, externalUrls, provenance, type DetailLevel } from './_shared.ts';

export const genres = table('genres', {
	name: text().primaryKey(),
	firstSeenAt: tsNow()
});

// ---------------------------------------------------------------- artists

export const artists = table(
	'artists',
	{
		id: text().primaryKey(),
		name: text().notNull(),
		popularity: smallint(),
		followersTotal: integer(),
		href: text(),
		uri: text(),
		externalUrls: externalUrls(),
		detailLevel: text().$type<DetailLevel>().notNull().default('simplified'),
		...provenance
	},
	(t) => [
		check('artists_detail_level', sql`${t.detailLevel} in ('simplified','full')`),
		// Drives the artist hydration phase seeder.
		index('artists_needs_hydrate_ix').on(t.id).where(sql`${t.detailLevel} = 'simplified'`),
		index('artists_name_trgm_ix').using('gin', sql`${t.name} gin_trgm_ops`)
	]
);

export const artistGenres = table(
	'artist_genres',
	{
		artistId: text()
			.notNull()
			.references(() => artists.id, { onDelete: 'cascade' }),
		genre: text()
			.notNull()
			.references(() => genres.name, { onDelete: 'cascade' })
	},
	(t) => [primaryKey({ columns: [t.artistId, t.genre] }), index('artist_genres_genre_ix').on(t.genre)]
);

/**
 * Images live in per-entity tables keyed by (entity, position) rather than a
 * shared `images` table behind a junction. Measured on the real library the
 * dedup ratio is 1.00004 (72,302 rows → 72,299 distinct URLs), so a junction
 * saves nothing and costs a join on every card render.
 */
export const artistImages = table(
	'artist_images',
	{
		artistId: text()
			.notNull()
			.references(() => artists.id, { onDelete: 'cascade' }),
		position: smallint().notNull(),
		url: text().notNull(),
		width: integer(),
		height: integer()
	},
	(t) => [primaryKey({ columns: [t.artistId, t.position] })]
);

// ----------------------------------------------------------------- albums

/**
 * One row per *release*, collapsing the editions Spotify keeps apart: a single
 * re-issued for three markets, an album and its "Deluxe" twin with an identical
 * track list, a soundtrack listed once as `album` and once as `compilation`.
 * Two albums group when they carry the same canonical tracks, ignoring order.
 *
 * DERIVED by `spotidata.refresh_album_groups()`; like `canonicalTracks` it
 * holds ZERO user data, so a regrouping can never orphan anything. Albums we do
 * not hold in full keep a `solo` group of their own — see the SQL for why.
 */
export const albumGroups = table(
	'album_groups',
	{
		/** 'trk:<24 hex>' for a track-set match, 'alb:<album id>' for a group of one. */
		id: text().primaryKey(),
		kind: text().$type<'tracks' | 'solo'>().notNull(),
		/** The chosen edition's title; see the ORDER BY in refresh_album_groups. */
		title: text().notNull(),
		representativeAlbumId: text().notNull(),
		primaryArtistId: text().references(() => artists.id),
		trackCount: integer().notNull().default(0),
		/** Editions in the group; > 1 means we actually deduplicated something. */
		copyCount: integer().notNull().default(1),
		earliestReleaseDate: date(),
		refreshedAt: tsNow()
	},
	(t) => [
		check('album_groups_kind', sql`${t.kind} in ('tracks','solo')`),
		index('album_groups_artist_ix').on(t.primaryArtistId),
		index('album_groups_dupes_ix').on(t.id).where(sql`${t.copyCount} > 1`)
	]
);

export const albums = table(
	'albums',
	{
		id: text().primaryKey(),
		name: text().notNull(),
		albumType: text(),
		/** Spotify's ragged date: "1998" | "1998-03" | "1998-03-14". */
		releaseDate: text(),
		releaseDatePrecision: text(),
		/**
		 * A real, indexable date derived from the ragged string above.
		 *
		 * Delegated to an IMMUTABLE plpgsql function (db/sql/pre/010) because a
		 * bare `make_date(...)` expression raises on the malformed dates Spotify
		 * actually returns — a single album with release_date "0000" aborts the
		 * whole batch insert, and a generated column cannot catch that.
		 */
		releaseDateStart: date().generatedAlwaysAs(
			sql`spotidata.parse_release_date(release_date)`
		),
		totalTracks: integer(),
		label: text(),
		popularity: smallint(),
		upc: text(),
		copyrights: jsonb(),
		availableMarkets: text().array().notNull().default(sql`'{}'::text[]`),
		restrictions: jsonb(),
		href: text(),
		uri: text(),
		externalUrls: externalUrls(),
		detailLevel: text().$type<DetailLevel>().notNull().default('simplified'),
		/** True once every one of `totalTracks` rows exists in spotify_tracks. */
		tracksComplete: boolean().notNull().default(false),
		tracksFetchedAt: ts(),
		albumGroupId: text().references(() => albumGroups.id, { onDelete: 'set null' }),
		...provenance
	},
	(t) => [
		check('albums_detail_level', sql`${t.detailLevel} in ('simplified','full')`),
		index('albums_group_ix').on(t.albumGroupId),
		check('albums_type', sql`${t.albumType} is null or ${t.albumType} in ('album','single','compilation')`),
		index('albums_release_ix').on(t.releaseDateStart),
		index('albums_label_ix').on(t.label).where(sql`${t.label} is not null`),
		index('albums_incomplete_ix').on(t.id).where(sql`not ${t.tracksComplete}`),
		index('albums_name_trgm_ix').using('gin', sql`${t.name} gin_trgm_ops`)
	]
);

export const albumArtists = table(
	'album_artists',
	{
		albumId: text()
			.notNull()
			.references(() => albums.id, { onDelete: 'cascade' }),
		artistId: text()
			.notNull()
			.references(() => artists.id, { onDelete: 'cascade' }),
		position: smallint().notNull().default(0)
	},
	(t) => [
		primaryKey({ columns: [t.albumId, t.artistId] }),
		index('album_artists_artist_ix').on(t.artistId)
	]
);

export const albumImages = table(
	'album_images',
	{
		albumId: text()
			.notNull()
			.references(() => albums.id, { onDelete: 'cascade' }),
		position: smallint().notNull(),
		url: text().notNull(),
		width: integer(),
		height: integer()
	},
	(t) => [primaryKey({ columns: [t.albumId, t.position] })]
);

export const albumGenres = table(
	'album_genres',
	{
		albumId: text()
			.notNull()
			.references(() => albums.id, { onDelete: 'cascade' }),
		genre: text()
			.notNull()
			.references(() => genres.name, { onDelete: 'cascade' })
	},
	(t) => [primaryKey({ columns: [t.albumId, t.genre] })]
);

// ----------------------------------------------------------------- tracks

/**
 * A canonical track is an ISRC — the recording — not a Spotify track ID.
 * The real library carries ~19% duplication (10,802 track IDs → 8,788 ISRCs,
 * with one recording appearing under 14 distinct IDs), so every statistic
 * dedupes through this table.
 *
 * INVARIANT: this table and `canonicalTrackArtists` hold ZERO user data and
 * are fully rebuildable by `spotidata.refresh_canonical_tracks()`. Anything
 * user-authored must key on `spotifyTracks.id` instead, so that a regrouping
 * can never orphan it.
 */
export const canonicalTracks = table(
	'canonical_tracks',
	{
		/** 'isrc:USUM71703861' for the 99.5% case, 'fb:<24 hex>' otherwise. */
		id: text().primaryKey(),
		kind: text().$type<'isrc' | 'fallback'>().notNull(),
		isrc: text().unique(),
		title: text().notNull(),
		durationMs: integer().notNull(),
		explicit: boolean().notNull().default(false),
		/** The copy chosen for display; see the ORDER BY in refresh_canonical. */
		representativeTrackId: text().notNull(),
		primaryArtistId: text().references(() => artists.id),
		primaryAlbumId: text().references(() => albums.id),
		maxPopularity: smallint(),
		copyCount: integer().notNull().default(1),
		earliestReleaseDate: date(),
		refreshedAt: tsNow()
	},
	(t) => [
		check('canonical_tracks_kind', sql`${t.kind} in ('isrc','fallback')`),
		index('canonical_tracks_artist_ix').on(t.primaryArtistId),
		index('canonical_tracks_title_trgm_ix').using('gin', sql`${t.title} gin_trgm_ops`)
	]
);

export const spotifyTracks = table(
	'spotify_tracks',
	{
		id: text().primaryKey(),
		name: text().notNull(),
		albumId: text().references(() => albums.id),
		durationMs: integer().notNull(),
		discNumber: smallint().notNull().default(1),
		trackNumber: smallint().notNull().default(0),
		explicit: boolean().notNull().default(false),
		/** NULL when unknown — simplified objects omit it entirely. */
		popularity: smallint(),
		/** Present on full track objects only; absent from album track listings. */
		isrc: text(),
		/** Deprecated by Spotify and always null since 2024. Kept for the record. */
		previewUrl: text(),
		isLocal: boolean().notNull().default(false),
		isPlayable: boolean(),
		/** Track relinking: the original ID this row was substituted for. */
		linkedFromId: text(),
		restrictionReason: text(),
		availableMarkets: text().array().notNull().default(sql`'{}'::text[]`),
		href: text(),
		uri: text().notNull(),
		externalUrls: externalUrls(),
		detailLevel: text().$type<DetailLevel>().notNull().default('simplified'),
		canonicalTrackId: text().references(() => canonicalTracks.id, { onDelete: 'set null' }),
		...provenance
	},
	(t) => [
		check('spotify_tracks_detail_level', sql`${t.detailLevel} in ('simplified','full')`),
		index('tracks_album_order_ix').on(t.albumId, t.discNumber, t.trackNumber),
		index('tracks_isrc_ix').on(t.isrc).where(sql`${t.isrc} is not null`),
		index('tracks_canonical_ix').on(t.canonicalTrackId),
		index('tracks_needs_hydrate_ix')
			.on(t.id)
			.where(sql`${t.detailLevel} = 'simplified' and not ${t.isLocal}`),
		index('tracks_name_trgm_ix').using('gin', sql`${t.name} gin_trgm_ops`)
	]
);

export const trackArtists = table(
	'track_artists',
	{
		trackId: text()
			.notNull()
			.references(() => spotifyTracks.id, { onDelete: 'cascade' }),
		artistId: text()
			.notNull()
			.references(() => artists.id, { onDelete: 'cascade' }),
		position: smallint().notNull().default(0)
	},
	(t) => [
		primaryKey({ columns: [t.trackId, t.artistId] }),
		index('track_artists_artist_ix').on(t.artistId)
	]
);

/**
 * The union of artists across ALL copies of a canonical track.
 *
 * Copies of one recording often credit different artists — "Calabria" vs
 * "Calabria (feat. Lujavo & Nito-Onna)" share an ISRC but not a credit list.
 * Taking the union keeps the featured artist's page complete, while charts
 * that need exactly one artist per track filter on
 * `onRepresentative AND position = 0`.
 */
export const canonicalTrackArtists = table(
	'canonical_track_artists',
	{
		canonicalTrackId: text()
			.notNull()
			.references(() => canonicalTracks.id, { onDelete: 'cascade' }),
		artistId: text()
			.notNull()
			.references(() => artists.id, { onDelete: 'cascade' }),
		position: smallint().notNull(),
		onRepresentative: boolean().notNull()
	},
	(t) => [
		primaryKey({ columns: [t.canonicalTrackId, t.artistId] }),
		index('cta_artist_ix').on(t.artistId)
	]
);

/** Manual escape hatch; applied at highest precedence during a refresh. */
export const canonicalOverrides = table('canonical_overrides', {
	trackId: text().primaryKey(),
	canonicalTrackId: text().notNull(),
	reason: text(),
	createdAt: tsNow()
});
