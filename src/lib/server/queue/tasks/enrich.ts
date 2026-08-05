import type { Task } from 'graphile-worker';
import { sql } from 'drizzle-orm';
import { db, query } from '../../db/index.ts';
import { loadSettings, type Settings } from '../../settings.ts';
import { logEvent } from '../phases.ts';
import { ServiceBlocked, MusicbrainzError } from '../../musicbrainz/errors.ts';
import {
	fetchGenreVocabulary,
	lookupArtist,
	lookupIsrc,
	lookupRelease,
	lookupSpotifyAlbumUrl,
	lookupSpotifyArtistUrl
} from '../../musicbrainz/endpoints.ts';
import { AB_BATCH, fetchAudioAnalysis } from '../../musicbrainz/acousticbrainz.ts';
import {
	linkAlbum,
	linkArtist,
	saveArtistDetail,
	saveAudioAnalysis,
	saveGenreVocabulary,
	saveIsrcLookup,
	saveRelease
} from '../../musicbrainz/ingest.ts';
import { PRIORITY_ENRICH } from '../constants.ts';

/**
 * MusicBrainz enrichment, run as a single self-chaining job.
 *
 * The shape is dictated by the rate limit. MusicBrainz allows one request per
 * second per IP and has no batch lookup, so the entire pipeline is a serial
 * crawl measured in hours — which rules out the fan-out-and-count design the
 * Spotify sync uses. Instead one job does a bounded slice of whichever stage
 * has work, then re-enqueues itself; a cron entry restarts the chain if it
 * ever stops. Parallelism would not make it faster, only ruder.
 *
 * Stages run in dependency order and each is a strict prerequisite of the
 * next: nothing can be asked about a recording before the ISRC has resolved to
 * one, and no artist can be identified for free before its recordings exist.
 */

export const ENRICH_JOB_KEY = 'enrich-tick';

/** Bounded so a single job stays around half a minute of wall clock. */
const BATCH = {
	recordings: 25,
	/** Recordings per tick; AcousticBrainz takes 25 per request, twice over. */
	audio: 4 * AB_BATCH,
	artistDetails: 15,
	artistUrls: 10,
	albums: 10
} as const;

/** Re-fetch the genre vocabulary about as often as it meaningfully changes. */
const GENRE_TTL_DAYS = 30;

interface StageResult {
	/** Items looked at; zero means the stage has nothing left to do. */
	processed: number;
	done: number;
	missed: number;
	requests: number;
}

const NOTHING: StageResult = { processed: 0, done: 0, missed: 0, requests: 0 };

// ------------------------------------------------------------ bookkeeping

async function markStage(
	key: string,
	status: 'idle' | 'running' | 'complete' | 'error' | 'blocked',
	result: StageResult = NOTHING,
	error?: string
): Promise<void> {
	await db.execute(sql`
		insert into enrich_stages (key, status, done, missed, requests, last_error, last_run_at, started_at)
		values (${key}, ${status}, ${result.done}, ${result.missed}, ${result.requests},
		        ${error ?? null}, now(), now())
		on conflict (key) do update set
		  status      = excluded.status,
		  done        = enrich_stages.done + excluded.done,
		  missed      = enrich_stages.missed + excluded.missed,
		  requests    = enrich_stages.requests + excluded.requests,
		  last_error  = excluded.last_error,
		  last_run_at = now(),
		  started_at  = coalesce(enrich_stages.started_at, now()),
		  finished_at = case when excluded.status = 'complete' then now() else null end,
		  updated_at  = now()
	`);
}

/**
 * A per-item failure that is the item's fault — a malformed ISRC, an entity
 * MusicBrainz rejects — must not be retried forever, or the chain wedges on
 * one bad row and never reaches the rest of the library. 4xx is recorded as a
 * miss; anything else is transient and left to the next pass.
 */
function isPermanent(err: unknown): boolean {
	return err instanceof MusicbrainzError && err.status >= 400 && err.status < 500;
}

// ---------------------------------------------------------------- stages

/**
 * MusicBrainz's curated genre list. Twenty-odd requests, once a month, and the
 * thing that lets every later stage tell "shoegaze" from "seen live".
 */
async function stageGenres(): Promise<StageResult> {
	const [{ stale } = { stale: true }] = await query<{ stale: boolean }>(sql`
		select coalesce(max(fetched_at) < now() - make_interval(days => ${GENRE_TTL_DAYS}), true) as stale
		  from mb_genres
	`);
	if (!stale) return NOTHING;

	const names = await fetchGenreVocabulary();
	const written = await saveGenreVocabulary(names);
	// Touch every row so a partial fetch cannot leave the table permanently stale.
	await db.execute(sql`update mb_genres set fetched_at = now()`);
	return { processed: written, done: written, missed: 0, requests: Math.ceil(names.length / 100) };
}

/**
 * ISRC → recording, the seam between the two catalogs. Ordered by play count,
 * so the first hour of a crawl covers the music actually listened to.
 */
async function stageRecordings(): Promise<StageResult> {
	const pending = await query<{ isrc: string }>(sql`
		select c.isrc
		  from spotidata.enrich_recording_candidates c
		  left join isrc_recordings ir on ir.isrc = c.isrc
		 where ir.isrc is null
		 order by c.plays desc, c.isrc
		 limit ${BATCH.recordings}
	`);
	if (pending.length === 0) return NOTHING;

	const result = { ...NOTHING, processed: pending.length };
	for (const { isrc } of pending) {
		try {
			const recordings = await lookupIsrc(isrc);
			result.requests++;
			const mbid = await saveIsrcLookup(isrc, recordings);
			if (mbid) result.done++;
			else result.missed++;
		} catch (err) {
			if (err instanceof ServiceBlocked) throw err;
			if (!isPermanent(err)) throw err;
			await saveIsrcLookup(isrc, []);
			result.missed++;
		}
	}
	return result;
}

/** BPM, key and the mood classifiers, 25 recordings per request. */
async function stageAudio(): Promise<StageResult> {
	const pending = await query<{ mbid: string }>(sql`
		select ir.recording_mbid as mbid
		  from spotidata.enrich_recording_candidates c
		  join isrc_recordings ir on ir.isrc = c.isrc and ir.recording_mbid is not null
		  left join audio_features af on af.recording_mbid = ir.recording_mbid
		 where af.recording_mbid is null
		 group by ir.recording_mbid
		 order by max(c.plays) desc, ir.recording_mbid
		 limit ${BATCH.audio}
	`);
	if (pending.length === 0) return NOTHING;

	const result = { ...NOTHING, processed: pending.length };
	for (let i = 0; i < pending.length; i += AB_BATCH) {
		const ids = pending.slice(i, i + AB_BATCH).map((r) => r.mbid);
		const rows = await fetchAudioAnalysis(ids);
		result.requests += 2;
		await saveAudioAnalysis(rows);
		result.done += rows.filter((r) => r.status === 'ok').length;
		result.missed += rows.filter((r) => r.status === 'missing').length;
	}
	return result;
}

/**
 * Artists, in three passes of decreasing efficiency:
 *
 *   1. the free one — every recording already handed us its credit list, so
 *      `match_artists_by_credit()` links thousands of artists in one SQL
 *      statement and no requests at all;
 *   2. upgrading those stubs to full rows (life-span, origin, genres), one
 *      request each;
 *   3. the leftovers, matched through the Spotify link MusicBrainz stores as a
 *      relationship — exact, but a request per artist and mostly misses.
 *
 * Pass 2 goes before pass 3 deliberately: the artists already identified are
 * the ones the library actually contains, and a full row is worth more than
 * another uncertain match.
 */
async function stageArtists(): Promise<StageResult> {
	const result = { ...NOTHING };

	const [{ linked } = { linked: 0 }] = await query<{ linked: number }>(
		sql`select spotidata.match_artists_by_credit() as linked`
	);
	if (linked > 0) {
		result.processed += linked;
		result.done += linked;
	}

	const stubs = await query<{ mbid: string }>(sql`
		select am.mbid
		  from spotidata.enrich_artist_candidates c
		  join artist_musicbrainz am on am.artist_id = c.artist_id
		  join mb_artists ma on ma.mbid = am.mbid and ma.detail_level = 'stub'
		 group by am.mbid
		 order by sum(c.plays) desc, am.mbid
		 limit ${BATCH.artistDetails}
	`);

	for (const { mbid } of stubs) {
		result.processed++;
		try {
			const artist = await lookupArtist(mbid);
			result.requests++;
			if (artist) {
				await saveArtistDetail(artist);
				result.done++;
			} else {
				// The MBID resolved to nothing, which means it was merged away.
				// Promoting it stops the query above from offering it forever.
				await db.execute(
					sql`update mb_artists set detail_level = 'full', fetched_at = now() where mbid = ${mbid}`
				);
				result.missed++;
			}
		} catch (err) {
			if (err instanceof ServiceBlocked) throw err;
			if (!isPermanent(err)) throw err;
			await db.execute(
				sql`update mb_artists set detail_level = 'full', fetched_at = now() where mbid = ${mbid}`
			);
			result.missed++;
		}
	}

	const unmatched = await query<{ artistId: string }>(sql`
		select c.artist_id as "artistId"
		  from spotidata.enrich_artist_candidates c
		  left join artist_musicbrainz am on am.artist_id = c.artist_id
		 where am.artist_id is null
		 order by c.plays desc, c.artist_id
		 limit ${BATCH.artistUrls}
	`);

	for (const { artistId } of unmatched) {
		result.processed++;
		try {
			const stub = await lookupSpotifyArtistUrl(artistId);
			result.requests++;
			if (!stub) {
				await linkArtist(artistId, null, null);
				result.missed++;
				continue;
			}
			// The URL lookup answers with a stub; saving it as one means the pass
			// above picks it up next tick and fills in the rest.
			await saveArtistStub(stub.id, stub.name, stub['sort-name'], stub.type, stub.country);
			await linkArtist(artistId, stub.id, 'url');
			result.done++;
		} catch (err) {
			if (err instanceof ServiceBlocked) throw err;
			if (!isPermanent(err)) throw err;
			await linkArtist(artistId, null, null);
			result.missed++;
		}
	}

	return result;
}

async function saveArtistStub(
	mbid: string,
	name: string,
	sortName?: string,
	type?: string | null,
	country?: string | null
): Promise<void> {
	await db.execute(sql`
		insert into mb_artists (mbid, name, sort_name, type, country, detail_level)
		values (${mbid}, ${name}, ${sortName ?? null}, ${type ?? null}, ${country ?? null}, 'stub')
		on conflict (mbid) do update set
		  name      = excluded.name,
		  sort_name = coalesce(excluded.sort_name, mb_artists.sort_name),
		  type      = coalesce(excluded.type, mb_artists.type),
		  country   = coalesce(excluded.country, mb_artists.country)
	`);
}

/**
 * Albums, two requests each: the Spotify link resolves the *edition*, and the
 * edition's own lookup brings back the label, barcode, packaging and the
 * release group that collects every other pressing of the same record.
 */
async function stageAlbums(): Promise<StageResult> {
	const pending = await query<{ albumId: string }>(sql`
		select c.album_id as "albumId"
		  from spotidata.enrich_album_candidates c
		  left join album_musicbrainz amb on amb.album_id = c.album_id
		 where amb.album_id is null
		 order by c.plays desc, c.album_id
		 limit ${BATCH.albums}
	`);
	if (pending.length === 0) return NOTHING;

	const result = { ...NOTHING, processed: pending.length };
	for (const { albumId } of pending) {
		try {
			const stub = await lookupSpotifyAlbumUrl(albumId);
			result.requests++;
			if (!stub) {
				await linkAlbum(albumId, null, null);
				result.missed++;
				continue;
			}
			const full = await lookupRelease(stub.id);
			result.requests++;
			await saveRelease(full ?? stub);
			await linkAlbum(albumId, stub.id, 'url');
			result.done++;
		} catch (err) {
			if (err instanceof ServiceBlocked) throw err;
			if (!isPermanent(err)) throw err;
			await linkAlbum(albumId, null, null);
			result.missed++;
		}
	}
	return result;
}

// ------------------------------------------------------------ the chain

type StageKey = 'genres' | 'recordings' | 'audio' | 'artists' | 'albums';

const STAGES: { key: StageKey; run: () => Promise<StageResult>; enabled: (s: Settings) => boolean }[] =
	[
		{ key: 'genres', run: stageGenres, enabled: () => true },
		{ key: 'recordings', run: stageRecordings, enabled: () => true },
		{ key: 'audio', run: stageAudio, enabled: (s) => s['enrich.audioFeatures'] },
		{ key: 'artists', run: stageArtists, enabled: (s) => s['enrich.artists'] },
		{ key: 'albums', run: stageAlbums, enabled: (s) => s['enrich.albums'] }
	];

/**
 * Only one chain may run at a time — the cron kickstarter and a chained job
 * can otherwise overlap and spend the same second's request twice. A session
 * advisory lock on a dedicated connection is the cheapest correct guard; the
 * lock dies with the connection, so a crashed worker cannot wedge it.
 */
const LOCK_KEY = 0x5e17c4;

async function withEnrichLock<T>(fn: () => Promise<T>): Promise<T | null> {
	const client = await db.$client.connect();
	try {
		const { rows } = await client.query<{ locked: boolean }>(
			`SELECT pg_try_advisory_lock(${LOCK_KEY}) AS locked`
		);
		if (!rows[0]?.locked) return null;
		try {
			return await fn();
		} finally {
			await client.query(`SELECT pg_advisory_unlock(${LOCK_KEY})`);
		}
	} finally {
		client.release();
	}
}

export const enrichTick: Task = async (_payload, helpers) => {
	const settings = await loadSettings();
	if (!settings['enrich.enabled']) return;

	const outcome = await withEnrichLock(async () => {
		for (const stage of STAGES) {
			if (!stage.enabled(settings)) {
				await markStage(stage.key, 'idle');
				continue;
			}

			let result: StageResult;
			try {
				result = await stage.run();
			} catch (err) {
				if (err instanceof ServiceBlocked) {
					await markStage(stage.key, 'blocked', NOTHING, err.message);
					return { reschedule: err.until };
				}
				await markStage(stage.key, 'error', NOTHING, String(err).slice(0, 500));
				throw err;
			}

			// An empty stage is finished; move on to the next one in the same tick
			// rather than burning a scheduling round-trip on it.
			if (result.processed === 0) {
				await markStage(stage.key, 'complete');
				continue;
			}

			await markStage(stage.key, 'running', result);
			return { reschedule: null as Date | null };
		}
		return { finished: true as const };
	});

	// Another chain already holds the lock; it will keep itself going.
	if (outcome === null) return;

	// Every stage is exhausted. The chain ends here rather than idling on the
	// queue; the cron entry restarts it when new music arrives.
	if ('finished' in outcome) return;

	await helpers.addJob(
		'enrich:tick',
		{},
		{
			jobKey: ENRICH_JOB_KEY,
			jobKeyMode: 'replace',
			runAt: outcome.reschedule ?? undefined,
			priority: PRIORITY_ENRICH,
			maxAttempts: 5
		}
	);
};

/**
 * Clears the misses so the next pass asks again.
 *
 * MusicBrainz is edited continuously — this month's unknown recording is next
 * month's entry — and AcousticBrainz rows can appear for a recording that had
 * none. Everything here is a "we asked and were told no", never a match.
 */
export const enrichRetryMisses: Task = async (payload, helpers) => {
	const { scope = 'all' } = (payload ?? {}) as { scope?: 'all' | StageKey };

	if (scope === 'all' || scope === 'recordings') {
		await db.execute(sql`delete from isrc_recordings where status = 'not_found'`);
	}
	if (scope === 'all' || scope === 'audio') {
		await db.execute(sql`delete from audio_features where status = 'missing'`);
	}
	if (scope === 'all' || scope === 'artists') {
		await db.execute(sql`delete from artist_musicbrainz where status = 'not_found'`);
	}
	if (scope === 'all' || scope === 'albums') {
		await db.execute(sql`delete from album_musicbrainz where status = 'not_found'`);
	}

	await db.execute(sql`update enrich_stages set missed = 0, status = 'idle', finished_at = null`);
	await logEvent(null, 'info', `Enrichment misses cleared (${scope})`);

	await helpers.addJob(
		'enrich:tick',
		{},
		{ jobKey: ENRICH_JOB_KEY, jobKeyMode: 'replace', priority: PRIORITY_ENRICH }
	);
};
