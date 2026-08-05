import { config } from '../config.ts';
import { ServiceBlocked } from './errors.ts';
import { pace, penalize } from './limiter.ts';

/**
 * AcousticBrainz: BPM, musical key and a shelf of classifier probabilities,
 * keyed by MusicBrainz recording MBID.
 *
 * It stopped accepting submissions in 2022, so coverage is fixed and partial —
 * roughly half of a mainstream library, less for anything recent. It is still
 * the only open source of these numbers now that Spotify has withdrawn
 * /audio-features, and unlike that endpoint these are measurements of the
 * audio (Essentia) rather than a proprietary score.
 *
 * Two endpoints, both bulk, both capped at 25 ids:
 *   low-level   → the analysis itself (bpm, key, loudness). ~55 kB per
 *                 recording, which is why only the dozen fields worth keeping
 *                 are pulled out and the rest is dropped on the floor.
 *   high-level  → classifier verdicts (danceable, happy, acoustic…), ~10 kB.
 */

export const AB_SERVICE = 'acousticbrainz';
export const AB_BATCH = 25;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const INLINE_RETRIES = 2;

/** Every submission for one MBID, keyed "0", "1", … We only read the first. */
type Submissions<T> = Record<string, T>;

interface LowLevel {
	rhythm?: {
		bpm?: number;
		beats_count?: number;
		onset_rate?: number;
		danceability?: number;
	};
	tonal?: {
		key_key?: string;
		key_scale?: string;
		key_strength?: number;
		chords_key?: string;
		chords_scale?: string;
		chords_changes_rate?: number;
		tuning_frequency?: number;
	};
	lowlevel?: {
		average_loudness?: number;
		dynamic_complexity?: number;
		spectral_centroid?: { mean?: number };
	};
	metadata?: {
		audio_properties?: { length?: number; replay_gain?: number };
	};
}

interface Classifier {
	value?: string;
	probability?: number;
	all?: Record<string, number>;
}

interface HighLevel {
	highlevel?: Record<string, Classifier>;
}

async function abFetch<T>(path: string, mbids: string[]): Promise<Record<string, T>> {
	const url = new URL(`${config.acousticbrainz.baseUrl}/api/v1/${path}`);
	url.searchParams.set('recording_ids', mbids.join(';'));

	for (let attempt = 0; ; attempt++) {
		await pace(AB_SERVICE);

		const res = await fetch(url, {
			headers: {
				'User-Agent': config.musicbrainz.userAgent,
				Accept: 'application/json'
			}
		});

		if (res.ok) return (await res.json()) as Record<string, T>;

		const retryAfter = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
		if (res.status === 429) {
			throw new ServiceBlocked(
				AB_SERVICE,
				await penalize(AB_SERVICE, Number.isFinite(retryAfter) ? retryAfter : 60)
			);
		}
		if (res.status >= 500) {
			if (attempt < INLINE_RETRIES) {
				await sleep(1000 * 2 ** attempt);
				continue;
			}
			throw new ServiceBlocked(AB_SERVICE, await penalize(AB_SERVICE, 60));
		}
		// 400 means one of the ids is not a UUID, which is our bug, not theirs.
		throw new Error(`AcousticBrainz ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`);
	}
}

/** Probability that a two-class classifier chose `positive`. */
function probabilityOf(c: Classifier | undefined, positive: string): number | null {
	const p = c?.all?.[positive];
	return typeof p === 'number' ? p : null;
}

/** The index signature is what lets these rows go straight into `chunkRows`. */
export interface AudioAnalysis extends Record<string, unknown> {
	recordingMbid: string;
	status: 'ok' | 'missing';
	bpm: number | null;
	beatsCount: number | null;
	onsetRate: number | null;
	danceabilityRaw: number | null;
	keyKey: string | null;
	keyScale: string | null;
	keyStrength: number | null;
	chordsKey: string | null;
	chordsScale: string | null;
	chordsChangesRate: number | null;
	tuningFrequency: number | null;
	averageLoudness: number | null;
	replayGain: number | null;
	lengthSeconds: number | null;
	dynamicComplexity: number | null;
	spectralCentroid: number | null;
	danceable: number | null;
	aggressive: number | null;
	electronic: number | null;
	acoustic: number | null;
	happy: number | null;
	sad: number | null;
	party: number | null;
	relaxed: number | null;
	bright: number | null;
	tonal: number | null;
	instrumental: number | null;
	female: number | null;
	moodMirex: string | null;
	genreDortmund: string | null;
	genreElectronic: string | null;
	genreRosamerica: string | null;
	genreTzanetakis: string | null;
}

function empty(recordingMbid: string): AudioAnalysis {
	return {
		recordingMbid,
		status: 'missing',
		bpm: null,
		beatsCount: null,
		onsetRate: null,
		danceabilityRaw: null,
		keyKey: null,
		keyScale: null,
		keyStrength: null,
		chordsKey: null,
		chordsScale: null,
		chordsChangesRate: null,
		tuningFrequency: null,
		averageLoudness: null,
		replayGain: null,
		lengthSeconds: null,
		dynamicComplexity: null,
		spectralCentroid: null,
		danceable: null,
		aggressive: null,
		electronic: null,
		acoustic: null,
		happy: null,
		sad: null,
		party: null,
		relaxed: null,
		bright: null,
		tonal: null,
		instrumental: null,
		female: null,
		moodMirex: null,
		genreDortmund: null,
		genreElectronic: null,
		genreRosamerica: null,
		genreTzanetakis: null
	};
}

/**
 * Both endpoints for one batch of ≤25 MBIDs, folded into one row each.
 *
 * Every requested id comes back, including the ones with no analysis: a
 * 'missing' row is what stops the next pass from asking again, and at ~50%
 * coverage that is half the budget saved.
 */
export async function fetchAudioAnalysis(mbids: string[]): Promise<AudioAnalysis[]> {
	if (mbids.length === 0) return [];

	const [low, high] = await Promise.all([
		abFetch<Submissions<LowLevel>>('low-level', mbids),
		abFetch<Submissions<HighLevel>>('high-level', mbids)
	]);

	return mbids.map((mbid) => {
		const ll = low[mbid]?.['0'];
		const hl = high[mbid]?.['0']?.highlevel;
		if (!ll && !hl) return empty(mbid);

		const row = empty(mbid);
		row.status = 'ok';

		row.bpm = ll?.rhythm?.bpm ?? null;
		row.beatsCount = ll?.rhythm?.beats_count ?? null;
		row.onsetRate = ll?.rhythm?.onset_rate ?? null;
		row.danceabilityRaw = ll?.rhythm?.danceability ?? null;

		row.keyKey = ll?.tonal?.key_key ?? null;
		row.keyScale = ll?.tonal?.key_scale ?? null;
		row.keyStrength = ll?.tonal?.key_strength ?? null;
		row.chordsKey = ll?.tonal?.chords_key ?? null;
		row.chordsScale = ll?.tonal?.chords_scale ?? null;
		row.chordsChangesRate = ll?.tonal?.chords_changes_rate ?? null;
		row.tuningFrequency = ll?.tonal?.tuning_frequency ?? null;

		row.averageLoudness = ll?.lowlevel?.average_loudness ?? null;
		row.dynamicComplexity = ll?.lowlevel?.dynamic_complexity ?? null;
		row.spectralCentroid = ll?.lowlevel?.spectral_centroid?.mean ?? null;
		row.replayGain = ll?.metadata?.audio_properties?.replay_gain ?? null;
		row.lengthSeconds = ll?.metadata?.audio_properties?.length ?? null;

		if (hl) {
			row.danceable = probabilityOf(hl.danceability, 'danceable');
			row.aggressive = probabilityOf(hl.mood_aggressive, 'aggressive');
			row.electronic = probabilityOf(hl.mood_electronic, 'electronic');
			row.acoustic = probabilityOf(hl.mood_acoustic, 'acoustic');
			row.happy = probabilityOf(hl.mood_happy, 'happy');
			row.sad = probabilityOf(hl.mood_sad, 'sad');
			row.party = probabilityOf(hl.mood_party, 'party');
			row.relaxed = probabilityOf(hl.mood_relaxed, 'relaxed');
			row.bright = probabilityOf(hl.timbre, 'bright');
			row.tonal = probabilityOf(hl.tonal_atonal, 'tonal');
			row.instrumental = probabilityOf(hl.voice_instrumental, 'instrumental');
			row.female = probabilityOf(hl.gender, 'female');

			row.moodMirex = hl.moods_mirex?.value ?? null;
			row.genreDortmund = hl.genre_dortmund?.value ?? null;
			row.genreElectronic = hl.genre_electronic?.value ?? null;
			row.genreRosamerica = hl.genre_rosamerica?.value ?? null;
			row.genreTzanetakis = hl.genre_tzanetakis?.value ?? null;
		}

		return row;
	});
}
