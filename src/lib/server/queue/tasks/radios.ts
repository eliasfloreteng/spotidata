import type { AddJobsJobSpec, JobHelpers, Task } from 'graphile-worker';
import { sql } from 'drizzle-orm';
import { query } from '../../db/index.ts';
import { recordings } from '../../engine/recordings.ts';
import { syncSongRadio } from '../../entities/radio.ts';
import { SpotifyAuthExpired, SpotifyRateLimited } from '../../spotify/errors.ts';
import { WebPlayerError } from '../../spotify/web-player.ts';
import { PRIORITY_RADIO, SPOTIFY_FLAG } from '../constants.ts';

/**
 * Keeping a radio for every song in the library (`song_radios`).
 *
 * `radio:seed` runs after every completed sync and once a day, and queues a
 * `radio:sync` for each library recording whose radio is missing or older
 * than `MAX_AGE_DAYS` — Spotify regenerates radios, but slowly enough that a
 * month-old one still says what a record belongs with. Missing ones go first,
 * and among them the downloaded ones (the DJ tab's pool), then the most
 * played.
 *
 * The syncs run one at a time, in a queue of their own: each is two calls to
 * Spotify's web player, which has no bucket of ours behind it, and at most one
 * `/tracks` request through the bucket for the records the archive has never
 * seen. A first backfill of nine thousand songs takes a few hours, behind
 * everything else.
 */

export const MAX_AGE_DAYS = 30;
const QUEUE = 'song-radio';
/** How long to stay off the web player after it says 429 without a Retry-After. */
const WEB_PLAYER_BACKOFF_S = 120;

/** The web player said to back off; every queued sync waits until then. */
let pausedUntil = 0;

/** Every `radio:sync` job: one per seed, serial, behind everything else. */
const syncOptions = (trackId: string) => ({
	jobKey: `radio:${trackId}`,
	queueName: QUEUE,
	priority: PRIORITY_RADIO,
	flags: [SPOTIFY_FLAG],
	maxAttempts: 3
});

/**
 * One seed per library recording: a copy the archive holds, the representative.
 * A recording counts as synced when any of its copies has a radio, so a
 * regrouping that picks another representative does not refetch it.
 */
export async function radiosDue(): Promise<string[]> {
	const rows = await query<{ seed: string }>(sql`
		with lib as (
		  select ct.representative_track_id as seed,
		         r.isrc is not null as downloaded,
		         coalesce(cps.plays, 0) as plays,
		         (select max(sr.fetched_at)
		            from spotify_tracks st
		            join song_radios sr on sr.seed_track_id = st.id
		           where st.canonical_track_id = lc.canonical_track_id) as fetched
		    from library_canonical lc
		    join canonical_tracks ct on ct.id = lc.canonical_track_id
		    left join ${await recordings()} r on r.isrc = upper(ct.isrc)
		    left join canonical_play_stats cps on cps.canonical_track_id = lc.canonical_track_id
		)
		select seed from lib
		 where fetched is null or fetched < now() - make_interval(days => ${MAX_AGE_DAYS})
		 order by fetched nulls first, downloaded desc, plays desc, seed
	`);
	return rows.map((r) => r.seed);
}

export const seedRadios: Task = async (_payload, helpers) => {
	const due = await radiosDue();
	// The boolean is addJobs' preserve_run_at: a sync already queued (or
	// waiting out a rate limit) keeps its place rather than being re-queued.
	for (let i = 0; i < due.length; i += 500) {
		const specs: AddJobsJobSpec[] = due
			.slice(i, i + 500)
			.map((trackId) => ({ identifier: 'radio:sync', payload: { trackId }, ...syncOptions(trackId) }));
		await helpers.addJobs(specs, true);
	}
	if (due.length) helpers.logger.info(`[radios] queued ${due.length} song radio(s)`);
};

async function later(helpers: JobHelpers, trackId: string, until: Date): Promise<void> {
	await helpers.addJob(
		'radio:sync',
		{ trackId },
		{ ...syncOptions(trackId), runAt: until, jobKeyMode: 'replace' }
	);
}

export const syncRadio: Task = async (payload, helpers) => {
	const { trackId } = payload as { trackId: string };
	if (pausedUntil > Date.now()) return later(helpers, trackId, new Date(pausedUntil));
	try {
		await syncSongRadio(trackId);
	} catch (err) {
		if (err instanceof SpotifyRateLimited) return later(helpers, trackId, err.until);
		if (err instanceof WebPlayerError && err.status === 429) {
			pausedUntil = Date.now() + (err.retryAfterSeconds ?? WEB_PLAYER_BACKOFF_S) * 1000;
			return later(helpers, trackId, new Date(pausedUntil));
		}
		// Nothing to retry into until somebody signs in again; the next seeding
		// queues it afresh.
		if (err instanceof SpotifyAuthExpired) {
			helpers.logger.warn(`[radios] ${trackId}: the Spotify sign-in has expired`);
			return;
		}
		throw err;
	}
};
