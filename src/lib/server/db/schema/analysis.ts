import { bigint, check, index, integer, real, text } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { table, ts, tsNow } from './_shared.ts';

/**
 * Tempo and key measured by rbxport (`analyser/`, the same analysis Deckhand
 * runs on the stick) from Deezer's 30-second preview of the recording.
 *
 * Deezer has a preview for nearly every ISRC, so this covers nearly the whole
 * library. Keyed by ISRC rather than `canonical_tracks.id`, because that table
 * is derived: a stable id survives a canonical regrouping, and an analysis
 * costs a download and a decode.
 *
 * `missing` is a recording Deezer has no preview of; `failed` one whose
 * preview rbxport could not measure. Both are kept so the chain moves on, and
 * retrying the misses clears them.
 */
export const trackAnalysis = table(
	'track_analysis',
	{
		isrc: text().primaryKey(),
		status: text().$type<'ok' | 'missing' | 'failed'>().notNull(),
		/** The Deezer track whose preview was measured. */
		deezerTrackId: bigint({ mode: 'number' }),
		/** How the Deezer track was found: by the ISRC, or by title, artist and length. */
		matchedBy: text().$type<'isrc' | 'search'>(),
		bpm: real(),
		/** 0–1: how far the tempo stands out from the next best that is not a multiple of it. */
		bpmConfidence: real(),
		/** rbxport's name for the key, e.g. 'Ebm'. */
		keyName: text(),
		/** e.g. '2A'. */
		camelot: text(),
		/** Seconds of audio measured; about 30 for a preview. */
		seconds: real(),
		rms: real(),
		/** The analyser build, so a change to rbxport can be re-run. */
		analyser: text().notNull(),
		error: text(),
		analysedAt: tsNow()
	},
	(t) => [
		check('track_analysis_status', sql`${t.status} in ('ok','missing','failed')`),
		check('track_analysis_matched_by', sql`${t.matchedBy} in ('isrc','search')`),
		index('track_analysis_status_ix').on(t.status)
	]
);

/**
 * Token bucket per external service — Deezer's, for the analysis — enforced
 * across the SvelteKit and worker processes rather than per instance. Same
 * shape and same reasoning as `rate_limiter`, which stays Spotify's alone.
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
