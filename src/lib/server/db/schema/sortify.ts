import {
	bigint,
	boolean,
	check,
	doublePrecision,
	index,
	integer,
	primaryKey,
	smallint,
	text,
	uuid
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { table, tsNow } from './_shared.ts';

/**
 * Sortify, the iOS app that sorts liked songs into playlists, keeps all of its
 * state here: which playlists it sorts into, what the language model said, and
 * what the user decided. Like the automations, every table is user-authored
 * and keyed on something a regrouping cannot orphan — a Spotify id, or a song
 * key (`spotidata.sortify_song_key`), which is a hash of a normalised title and
 * an artist id rather than a canonical id.
 *
 * None of them describe the library. Membership is read live from
 * `playlist_tracks`; these only say how Sortify should treat it.
 */

/**
 * A playlist's eligibility, where the user overrode the default. Monthly
 * playlists, ones made by Spotify and ones nothing was added to in two years
 * are left out by default (`sortify/catalog.ts`); everything else is in. A row
 * exists only while the choice differs from the default it was made against,
 * so turning on a playlist that was on anyway records nothing.
 */
export const sortifyPlaylistOverrides = table('sortify_playlist_overrides', {
	/** No FK: a playlist created from the app exists before the next sync ingests it. */
	playlistId: text().primaryKey(),
	eligible: boolean().notNull(),
	updatedAt: tsNow()
});

/**
 * The feed card's suggestions, one row per Spotify track: up to three existing
 * playlists and two names for new ones, from one cheap model call per ten
 * songs. Cached for good; clearing is a button.
 */
export const sortifyCardSuggestions = table('sortify_card_suggestions', {
	trackId: text().primaryKey(),
	playlistIds: text().array().notNull().default(sql`'{}'::text[]`),
	ideas: text().array().notNull().default(sql`'{}'::text[]`),
	model: text().notNull(),
	createdAt: tsNow()
});

/**
 * Songs the sort mode's songs → playlists prompt has seen, with the new
 * playlist it would start for one that fits nowhere. A playlist that has no
 * verdict for a song in here is one the model looked at and turned down.
 */
export const sortifyAskedSongs = table('sortify_asked_songs', {
	songKey: text().primaryKey(),
	idea: text(),
	model: text().notNull(),
	askedAt: tsNow()
});

/**
 * The model's verdict on one song in one playlist. `confidence` 3 = belongs
 * there without doubt, 2 = a good fit, 1 = plausible; NULL is a playlist →
 * songs judgement that left the song out, kept so it is not asked again.
 */
export const sortifyVerdicts = table(
	'sortify_verdicts',
	{
		songKey: text().notNull(),
		playlistId: text().notNull(),
		confidence: smallint(),
		why: text(),
		/** Which prompt said so: the whole catalog for one song, or one playlist for many. */
		via: text().$type<'songs' | 'playlist'>().notNull(),
		model: text().notNull(),
		judgedAt: tsNow()
	},
	(t) => [
		primaryKey({ columns: [t.songKey, t.playlistId] }),
		index('sortify_verdicts_playlist_ix').on(t.playlistId),
		check('sortify_verdicts_via', sql`${t.via} in ('songs','playlist')`),
		check(
			'sortify_verdicts_confidence',
			sql`${t.confidence} is null or ${t.confidence} between 1 and 3`
		)
	]
);

/** Songs the user has been through in the sort queue, and when. */
export const sortifyReviewedSongs = table('sortify_reviewed_songs', {
	songKey: text().primaryKey(),
	/** The copy that was on screen, for reading the table; the key is what matters. */
	trackId: text(),
	reviewedAt: tsNow()
});

/** A suggestion the user turned down: this song is never offered to this playlist again. */
export const sortifyDismissals = table(
	'sortify_dismissals',
	{
		songKey: text().notNull(),
		playlistId: text().notNull(),
		dismissedAt: tsNow()
	},
	(t) => [primaryKey({ columns: [t.songKey, t.playlistId] })]
);

/** A playlist the model proposes for songs that fit none of the existing ones. */
export const sortifyIdeas = table('sortify_ideas', {
	id: uuid().primaryKey().defaultRandom(),
	name: text().notNull(),
	description: text().notNull().default(''),
	songKeys: text().array().notNull(),
	model: text().notNull(),
	createdAt: tsNow()
});

/** Every OpenRouter request, for the spend shown in the app and for working out what a prompt costs. */
export const sortifyAiRequests = table(
	'sortify_ai_requests',
	{
		id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
		kind: text().$type<'card' | 'songs' | 'playlist' | 'ideas'>().notNull(),
		model: text().notNull(),
		/** Songs in the prompt. */
		items: integer().notNull(),
		/** What OpenRouter billed, in USD. */
		costUsd: doublePrecision(),
		durationMs: integer(),
		error: text(),
		createdAt: tsNow()
	},
	(t) => [check('sortify_ai_requests_kind', sql`${t.kind} in ('card','songs','playlist','ideas')`)]
);
