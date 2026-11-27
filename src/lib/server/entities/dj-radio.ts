import { radioFailure, songRadio, type SongRadio } from './radio.ts';

/**
 * What Spotify's radio says about a set, as the DJ tab's "sounds like" signal.
 *
 * Key and tempo say whether two records *can* be mixed; nothing in them says
 * whether they belong in the same set — a jazz record and a techno one meet
 * at 8A and 124 BPM all the time. Spotify withdrew every Web API that knew
 * (recommendations, related artists, audio features), but a song's radio is
 * still that judgement: fifty records Spotify plays after this one. So the
 * set's last few tracks each contribute their radio, the newest weighing most,
 * and a suggestion scores by being in one (the recording or another release
 * of the song) or, more weakly, by sharing an artist with one.
 *
 * Unlike `/radio/<id>`, which shows what Spotify plays right now, this is
 * cached: every track added to a set reloads the page, and the radio of a
 * track three back has not changed in the meantime. Only in memory — it is a
 * ranking hint, and losing it on a restart costs one refetch per track.
 */

/** The set's last tracks, newest first, and how much each one's radio counts. */
export const RADIO_SEED_WEIGHTS = [1, 0.5, 0.25] as const;

/** How long the page waits for radios before ranking without the missing ones. */
const BUDGET_MS = 5_000;
const TTL_MS = 6 * 60 * 60_000;
/** A failure is remembered briefly, so an outage does not cost every page load a wait. */
const FAILURE_TTL_MS = 2 * 60_000;
const MAX_CACHED = 200;

export interface RadioEntry {
	/** Which of the set's tracks this radio came from: 0 is the last one. */
	seed: number;
	weight: number;
	/** The Spotify id the radio plays. */
	id: string;
	/** The recording, when the archive has seen any copy of it. */
	canonicalId: string | null;
	title: string;
	/** Every credited artist, the primary one first. */
	artistIds: string[];
}

export interface SetRadio {
	entries: RadioEntry[];
	/** How many of the asked-for radios came in. */
	heard: number;
	asked: number;
	/** Why one or more did not, for a person; null when all did. */
	problem: string | null;
}

interface Cached {
	expires: number;
	radio: Promise<SongRadio | null>;
}

const cache = new Map<string, Cached>();

function cachedRadio(trackId: string): Promise<SongRadio | null> {
	const now = Date.now();
	const hit = cache.get(trackId);
	if (hit && hit.expires > now) {
		// Re-inserting keeps the Map in least-recently-used order for eviction.
		cache.delete(trackId);
		cache.set(trackId, hit);
		return hit.radio;
	}
	const entry: Cached = { expires: now + TTL_MS, radio: songRadio(trackId) };
	entry.radio.catch(() => {
		entry.expires = Math.min(entry.expires, Date.now() + FAILURE_TTL_MS);
	});
	cache.delete(trackId);
	cache.set(trackId, entry);
	while (cache.size > MAX_CACHED) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
	return entry.radio;
}

const TIMED_OUT = Symbol('timed out');

/**
 * The radios of `trackIds` (Spotify ids, newest first), merged. Never throws:
 * a radio that fails or is slow is left out and named in `problem`, and the
 * suggestions are ranked on what did come in. A slow one keeps loading into
 * the cache, so the next page load has it.
 */
export async function setRadio(trackIds: string[]): Promise<SetRadio> {
	const seeds = trackIds.slice(0, RADIO_SEED_WEIGHTS.length);
	if (seeds.length === 0) return { entries: [], heard: 0, asked: 0, problem: null };

	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
		timer = setTimeout(() => resolve(TIMED_OUT), BUDGET_MS);
	});
	const results = await Promise.allSettled(seeds.map((id) => Promise.race([cachedRadio(id), deadline])));
	clearTimeout(timer);

	const entries: RadioEntry[] = [];
	const problems = new Set<string>();
	let heard = 0;
	results.forEach((r, seed) => {
		if (r.status === 'rejected') {
			const failure = radioFailure(r.reason);
			if (!failure) console.error('[dj radio]', seeds[seed], r.reason);
			problems.add(failure?.message ?? 'Fetching the radio failed.');
			return;
		}
		if (r.value === TIMED_OUT) {
			problems.add('Spotify was slow to answer; the radio will be in on the next load.');
			return;
		}
		heard++;
		// No radio for a track is an answer, not a failure: it simply adds nothing.
		for (const t of r.value?.tracks ?? []) {
			entries.push({
				seed,
				weight: RADIO_SEED_WEIGHTS[seed] ?? 0,
				id: t.id,
				canonicalId: t.canonical_id,
				title: t.title,
				artistIds: t.artists.map((a) => a.id)
			});
		}
	});
	return { entries, heard, asked: seeds.length, problem: problems.size ? [...problems].join(' ') : null };
}
