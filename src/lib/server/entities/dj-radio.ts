import { sql } from 'drizzle-orm';
import { query } from '../db/index.ts';
import { radioFailure, syncSongRadio } from './radio.ts';

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
 * The radios are the synced ones (`song_radios`, kept for every library
 * recording by `queue/tasks/radios.ts`). A set track the sync has not reached
 * yet is fetched here, and stored, so the next page load reads it too.
 */

/** The set's last tracks, newest first, and how much each one's radio counts. */
export const RADIO_SEED_WEIGHTS = [1, 0.5, 0.25] as const;

/** How long the page waits for a radio not synced yet before ranking without it. */
const BUDGET_MS = 5_000;

/** A radio to rank by: the seed whose stored radio it is, and its weight. */
export interface RadioSeed {
	/** Which of the set's tracks: 0 is the last one. */
	seed: number;
	trackId: string;
	weight: number;
}

export interface SetRadio {
	seeds: RadioSeed[];
	/** Records across those radios. */
	tracks: number;
	/** How many of the asked-for radios are known — a track with no radio counts. */
	heard: number;
	asked: number;
	/** Why one or more are not, for a person; null when all are. */
	problem: string | null;
}

interface Stored {
	canonicalId: string;
	trackId: string;
	playlistId: string | null;
	trackCount: number;
}

/** The freshest stored radio of each recording, under any of its copies. */
async function stored(canonicalIds: string[]): Promise<Map<string, Stored>> {
	const rows = await query<Stored>(sql`
		select distinct on (st.canonical_track_id)
		       st.canonical_track_id as "canonicalId",
		       sr.seed_track_id as "trackId",
		       sr.playlist_id as "playlistId",
		       sr.track_count as "trackCount"
		  from song_radios sr
		  join spotify_tracks st on st.id = sr.seed_track_id
		 where st.canonical_track_id in (
		         select value from jsonb_array_elements_text(${JSON.stringify(canonicalIds)}::jsonb)
		       )
		 order by st.canonical_track_id, sr.fetched_at desc
	`);
	return new Map(rows.map((r) => [r.canonicalId, r]));
}

/** Fetches still running, so a reload while one is slow does not start a second. */
const inFlight = new Map<string, Promise<boolean>>();

function syncOnce(trackId: string): Promise<boolean> {
	let p = inFlight.get(trackId);
	if (!p) {
		p = syncSongRadio(trackId).finally(() => inFlight.delete(trackId));
		inFlight.set(trackId, p);
	}
	return p;
}

const TIMED_OUT = Symbol('timed out');

/**
 * The radios of a set's last tracks, given newest first as recordings and
 * the Spotify id to seed a missing one from. Never throws: a radio that
 * cannot be had is left out and named in `problem`, and the suggestions rank
 * on the rest. A slow fetch carries on and is stored when it lands.
 */
export async function setRadio(set: Array<{ canonicalId: string; trackId: string }>): Promise<SetRadio> {
	const wanted = set.slice(0, RADIO_SEED_WEIGHTS.length);
	if (wanted.length === 0) return { seeds: [], tracks: 0, heard: 0, asked: 0, problem: null };

	let have = await stored(wanted.map((t) => t.canonicalId));
	const missing = wanted.filter((t) => !have.has(t.canonicalId));
	const problems = new Set<string>();

	if (missing.length > 0) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
			timer = setTimeout(() => resolve(TIMED_OUT), BUDGET_MS);
		});
		const results = await Promise.allSettled(
			missing.map((t) => Promise.race([syncOnce(t.trackId), deadline]))
		);
		clearTimeout(timer);
		for (const [i, r] of results.entries()) {
			if (r.status === 'rejected') {
				const failure = radioFailure(r.reason);
				if (!failure) console.error('[dj radio]', missing[i]?.trackId, r.reason);
				problems.add(failure?.message ?? 'Fetching the radio failed.');
			} else if (r.value === TIMED_OUT) {
				problems.add('Spotify was slow to answer; the radio will be in on the next load.');
			}
		}
		have = await stored(wanted.map((t) => t.canonicalId));
	}

	const seeds: RadioSeed[] = [];
	let tracks = 0;
	let heard = 0;
	wanted.forEach((t, seed) => {
		const radio = have.get(t.canonicalId);
		if (!radio) return;
		heard++;
		if (!radio.playlistId || radio.trackCount === 0) return;
		tracks += radio.trackCount;
		seeds.push({ seed, trackId: radio.trackId, weight: RADIO_SEED_WEIGHTS[seed] ?? 0 });
	});
	return {
		seeds,
		tracks,
		heard,
		asked: wanted.length,
		problem: problems.size ? [...problems].join(' ') : null
	};
}
