import {
	boolean,
	check,
	date,
	index,
	integer,
	primaryKey,
	real,
	smallint,
	text
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { table, ts, tsNow } from './_shared.ts';
import { albums, artists } from './catalog.ts';

/**
 * Everything Spotify does not know about the music, fetched from MusicBrainz
 * and AcousticBrainz.
 *
 * KEYING, which is the whole design: MusicBrainz rows hang off MBIDs and are
 * reached from our catalog through *stable* identifiers only — an ISRC for a
 * recording, a Spotify id for an artist or album. Nothing keys on
 * `canonical_tracks.id`, because that table is derived and a regrouping would
 * throw away hours of 1-request-per-second crawling. `isrc_recordings` is the
 * join table that makes a recording reachable: canonical_tracks.isrc → mbid.
 *
 * Every lookup table also records the MISSES (`status = 'not_found'`), so a
 * recording MusicBrainz has never heard of costs one request ever rather than
 * one per enrichment pass.
 */

// -------------------------------------------------------------- vocabulary

/**
 * MusicBrainz's curated genre list (~2,000 names), fetched whole from
 * /ws/2/genre/all. Tags are free-form and include things like "seen live" and
 * "80s"; joining against this table is what separates a genre from a mood, a
 * decade or an opinion.
 */
export const mbGenres = table('mb_genres', {
	name: text().primaryKey(),
	fetchedAt: tsNow()
});

/**
 * Folksonomy tags on any MusicBrainz entity, with the vote count that came
 * with them. `isGenre` is set when MusicBrainz itself served the value under
 * `inc=genres` rather than `inc=tags`; the join to `mb_genres` catches the
 * rest, since a genre tag on an entity we only fetched tags for is still a
 * genre.
 */
export const mbTags = table(
	'mb_tags',
	{
		entityType: text().$type<'recording' | 'artist' | 'release' | 'release_group'>().notNull(),
		entityMbid: text().notNull(),
		tag: text().notNull(),
		count: integer().notNull().default(0),
		isGenre: boolean().notNull().default(false)
	},
	(t) => [
		primaryKey({ columns: [t.entityType, t.entityMbid, t.tag] }),
		check(
			'mb_tags_entity_type',
			sql`${t.entityType} in ('recording','artist','release','release_group')`
		),
		index('mb_tags_tag_ix').on(t.tag),
		index('mb_tags_genre_ix').on(t.entityType, t.tag).where(sql`${t.isGenre}`)
	]
);

// -------------------------------------------------------------- recordings

export const mbRecordings = table(
	'mb_recordings',
	{
		mbid: text().primaryKey(),
		title: text().notNull(),
		/** MusicBrainz's own duration, which is the *recording's*, not an edit's. */
		lengthMs: integer(),
		/** Ragged like Spotify's: "1998" | "1998-03" | "1998-03-14". */
		firstReleaseDate: text(),
		/** Indexable form of the above; see db/sql/pre/010_release_date.sql. */
		firstReleaseDateStart: date().generatedAlwaysAs(
			sql`spotidata.parse_release_date(first_release_date)`
		),
		disambiguation: text(),
		video: boolean().notNull().default(false),
		fetchedAt: tsNow()
	},
	(t) => [index('mb_recordings_release_ix').on(t.firstReleaseDateStart)]
);

/**
 * ISRC → recording. The ISRC is the one identifier Spotify and MusicBrainz
 * genuinely share, so this is the seam between the two catalogs.
 *
 * `candidates` counts how many recordings the ISRC resolved to. More than one
 * is common and harmless — MusicBrainz keeps a separate recording per edit
 * (radio, extended, remaster) while sharing the ISRC — so the earliest release
 * wins and the count is kept to make that choice auditable.
 */
export const isrcRecordings = table(
	'isrc_recordings',
	{
		isrc: text().primaryKey(),
		recordingMbid: text().references(() => mbRecordings.mbid, { onDelete: 'set null' }),
		status: text().$type<'matched' | 'not_found'>().notNull(),
		candidates: smallint().notNull().default(0),
		lookedUpAt: tsNow()
	},
	(t) => [
		check('isrc_recordings_status', sql`${t.status} in ('matched','not_found')`),
		index('isrc_recordings_mbid_ix').on(t.recordingMbid)
	]
);

/** The credit list as MusicBrainz has it, in print order. */
export const mbRecordingArtists = table(
	'mb_recording_artists',
	{
		recordingMbid: text()
			.notNull()
			.references(() => mbRecordings.mbid, { onDelete: 'cascade' }),
		position: smallint().notNull(),
		artistMbid: text().notNull(),
		/** How this artist was credited *on this recording*, which can differ. */
		creditName: text().notNull(),
		joinPhrase: text()
	},
	(t) => [
		primaryKey({ columns: [t.recordingMbid, t.position] }),
		index('mb_recording_artists_artist_ix').on(t.artistMbid)
	]
);

// ----------------------------------------------------------------- artists

export const mbArtists = table(
	'mb_artists',
	{
		mbid: text().primaryKey(),
		name: text().notNull(),
		sortName: text(),
		/** 'Person' | 'Group' | 'Orchestra' | 'Choir' | 'Character' | 'Other'. */
		type: text(),
		gender: text(),
		/** ISO 3166-1, e.g. 'SE'. Present far more often than `areaName`. */
		country: text(),
		areaName: text(),
		/** Where they are *from*, which for a group is the city it formed in. */
		beginAreaName: text(),
		beginDate: text(),
		endDate: text(),
		ended: boolean().notNull().default(false),
		disambiguation: text(),
		ratingValue: real(),
		ratingVotes: integer(),
		/** International standard names; useful for reconciling against anything else. */
		isnis: text().array().notNull().default(sql`'{}'::text[]`),
		/**
		 * 'stub' rows arrive embedded in a recording's artist credit and carry
		 * name/type/country only; 'full' rows came from their own lookup and add
		 * genres, area, life-span and rating. The partial index below is what
		 * feeds the upgrade stage.
		 */
		detailLevel: text().$type<'stub' | 'full'>().notNull().default('stub'),
		fetchedAt: tsNow()
	},
	(t) => [
		check('mb_artists_detail_level', sql`${t.detailLevel} in ('stub','full')`),
		index('mb_artists_needs_detail_ix').on(t.mbid).where(sql`${t.detailLevel} = 'stub'`)
	]
);

/**
 * Spotify artist → MusicBrainz artist.
 *
 * `source` records how the link was made, because the two routes differ in
 * strength: 'url' is an exact match on the Spotify link MusicBrainz stores as
 * a relationship, while 'credit' infers it from an ISRC-matched recording
 * whose credited artist name equals ours. 'credit' is free (the data arrived
 * with the recording) and 'url' costs a request, so credit matching runs first
 * and the URL lookup only cleans up what it missed.
 */
export const artistMusicbrainz = table(
	'artist_musicbrainz',
	{
		artistId: text()
			.primaryKey()
			.references(() => artists.id, { onDelete: 'cascade' }),
		mbid: text().references(() => mbArtists.mbid, { onDelete: 'set null' }),
		status: text().$type<'matched' | 'not_found'>().notNull(),
		source: text().$type<'url' | 'credit'>(),
		lookedUpAt: tsNow()
	},
	(t) => [
		check('artist_musicbrainz_status', sql`${t.status} in ('matched','not_found')`),
		check('artist_musicbrainz_source', sql`${t.source} is null or ${t.source} in ('url','credit')`),
		index('artist_musicbrainz_mbid_ix').on(t.mbid)
	]
);

// ---------------------------------------------------------------- releases

/**
 * The work-level album: every edition, reissue and market variant of one
 * release collapses here, which is the same job `album_groups` does on the
 * Spotify side — from the other direction and with an authority behind it.
 */
export const mbReleaseGroups = table('mb_release_groups', {
	mbid: text().primaryKey(),
	title: text().notNull(),
	/** 'Album' | 'Single' | 'EP' | 'Broadcast' | 'Other'. */
	primaryType: text(),
	/** 'Compilation', 'Soundtrack', 'Live', 'Remix', 'DJ-mix'… */
	secondaryTypes: text().array().notNull().default(sql`'{}'::text[]`),
	firstReleaseDate: text(),
	disambiguation: text(),
	fetchedAt: tsNow()
});

export const mbReleases = table(
	'mb_releases',
	{
		mbid: text().primaryKey(),
		title: text().notNull(),
		/** 'Official' | 'Promotion' | 'Bootleg' | 'Pseudo-Release'. */
		status: text(),
		date: text(),
		country: text(),
		barcode: text(),
		packaging: text(),
		language: text(),
		script: text(),
		/** The label that actually issued this edition, which Spotify blurs. */
		labelName: text(),
		catalogNumber: text(),
		releaseGroupMbid: text().references(() => mbReleaseGroups.mbid, { onDelete: 'set null' }),
		fetchedAt: tsNow()
	},
	(t) => [
		index('mb_releases_group_ix').on(t.releaseGroupMbid),
		index('mb_releases_barcode_ix').on(t.barcode).where(sql`${t.barcode} is not null`)
	]
);

export const albumMusicbrainz = table(
	'album_musicbrainz',
	{
		albumId: text()
			.primaryKey()
			.references(() => albums.id, { onDelete: 'cascade' }),
		releaseMbid: text().references(() => mbReleases.mbid, { onDelete: 'set null' }),
		status: text().$type<'matched' | 'not_found'>().notNull(),
		/** 'url' is the stored Spotify link; 'barcode' matched on the UPC. */
		source: text().$type<'url' | 'barcode'>(),
		lookedUpAt: tsNow()
	},
	(t) => [
		check('album_musicbrainz_status', sql`${t.status} in ('matched','not_found')`),
		check('album_musicbrainz_source', sql`${t.source} is null or ${t.source} in ('url','barcode')`),
		index('album_musicbrainz_release_ix').on(t.releaseMbid)
	]
);

// --------------------------------------------------- acoustic analysis

/**
 * Per-recording audio analysis from AcousticBrainz — the replacement for
 * Spotify's withdrawn /audio-features, and better in one respect: these are
 * measurements of the actual audio (Essentia's extractor) rather than a
 * proprietary score.
 *
 * A row with `status = 'missing'` is a recording AcousticBrainz has never been
 * submitted an analysis for. It is stored so the next pass does not ask again;
 * coverage across a mainstream library runs around half.
 *
 * Scale notes, because they are not all 0–1:
 *   • `danceabilityRaw` is Essentia's 0–3 dance measure from the low-level
 *     extractor; `danceable` is the classifier's probability, which is 0–1.
 *   • `averageLoudness` is 0–1 and NOT dBFS; `replayGain` is dB.
 *   • `keyStrength` is how confident the key estimate is, not how "strong" the key is.
 */
export const audioFeatures = table(
	'audio_features',
	{
		recordingMbid: text()
			.primaryKey()
			.references(() => mbRecordings.mbid, { onDelete: 'cascade' }),
		status: text().$type<'ok' | 'missing'>().notNull(),

		// --- rhythm ---
		bpm: real(),
		beatsCount: integer(),
		onsetRate: real(),
		danceabilityRaw: real(),

		// --- tonal ---
		/** 'C', 'C#', … as estimated from the audio. */
		keyKey: text(),
		keyScale: text(),
		keyStrength: real(),
		chordsKey: text(),
		chordsScale: text(),
		chordsChangesRate: real(),
		tuningFrequency: real(),

		// --- loudness & shape ---
		averageLoudness: real(),
		replayGain: real(),
		lengthSeconds: real(),
		dynamicComplexity: real(),
		spectralCentroid: real(),

		// --- classifier probabilities, all 0–1 ---
		danceable: real(),
		aggressive: real(),
		electronic: real(),
		acoustic: real(),
		happy: real(),
		sad: real(),
		party: real(),
		relaxed: real(),
		/** P(bright timbre). */
		bright: real(),
		/** P(tonal), i.e. has a discernible key at all. */
		tonal: real(),
		/** P(instrumental) — the inverse is "has voice". */
		instrumental: real(),
		/** P(the classifier heard a female voice); meaningless when instrumental. */
		female: real(),

		/** Winning label of each genre classifier; four models, four opinions. */
		moodMirex: text(),
		genreDortmund: text(),
		genreElectronic: text(),
		genreRosamerica: text(),
		genreTzanetakis: text(),

		fetchedAt: tsNow()
	},
	(t) => [
		check('audio_features_status', sql`${t.status} in ('ok','missing')`),
		index('audio_features_bpm_ix').on(t.bpm).where(sql`${t.bpm} is not null`),
		index('audio_features_key_ix').on(t.keyKey, t.keyScale)
	]
);

// ------------------------------------------------------------ bookkeeping

/**
 * One row per enrichment stage: the cursor, the counters and the last error
 * for a crawl that runs for hours at one request per second and must survive
 * restarts, rate limits and being switched off halfway.
 *
 * Deliberately NOT `sync_runs`: a MusicBrainz pass takes a day, and parking it
 * in that table would hold the "one active run" index and block every Spotify
 * sync behind it.
 */
export const enrichStages = table(
	'enrich_stages',
	{
		key: text().primaryKey(),
		status: text()
			.$type<'idle' | 'running' | 'complete' | 'error' | 'blocked'>()
			.notNull()
			.default('idle'),
		/** Items resolved to something, ever. */
		done: integer().notNull().default(0),
		/** Items looked up and genuinely absent from MusicBrainz. */
		missed: integer().notNull().default(0),
		requests: integer().notNull().default(0),
		lastError: text(),
		lastRunAt: ts(),
		startedAt: ts(),
		finishedAt: ts(),
		updatedAt: tsNow()
	},
	(t) => [
		check(
			'enrich_stages_status',
			sql`${t.status} in ('idle','running','complete','error','blocked')`
		)
	]
);

/**
 * OAuth grants for third-party services other than Spotify, one row each.
 *
 * MusicBrainz needs none of this to be read: the web service is open, and the
 * whole enrichment pipeline runs unauthenticated. A grant only widens what
 * could be done *to* MusicBrainz — submitting tags, ratings or ISRCs back — so
 * the column is here, populated when credentials are configured, and nothing
 * in the crawl depends on it.
 */
export const externalTokens = table('external_tokens', {
	service: text().primaryKey(),
	accessToken: text().notNull(),
	refreshToken: text(),
	tokenType: text().notNull().default('Bearer'),
	scope: text().notNull().default(''),
	accessExpiresAt: ts(),
	authorizedAt: tsNow(),
	lastRefreshError: text(),
	updatedAt: tsNow()
});

/**
 * Token bucket per external service, so MusicBrainz's one-request-per-second
 * and AcousticBrainz's own pacing are enforced across the SvelteKit and worker
 * processes rather than per instance. Same shape and same reasoning as
 * `rate_limiter`, which stays Spotify's alone.
 */
export const externalLimiters = table('external_limiters', {
	service: text().primaryKey(),
	tokens: real().notNull().default(1),
	capacity: real().notNull().default(1),
	refillPerSec: real().notNull().default(1),
	lastRefill: tsNow(),
	blockedUntil: ts(),
	requestsTotal: integer().notNull().default(0),
	updatedAt: tsNow()
});
