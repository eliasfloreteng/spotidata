import { config } from '../config.ts';
import { ServiceBlocked } from '../musicbrainz/errors.ts';
import { pace, penalize } from '../musicbrainz/limiter.ts';

/**
 * Deezer's public API, for one thing: the 30-second preview of a recording,
 * which is the audio rbxport measures.
 *
 * Spotify withdrew `preview_url`; Deezer still serves one for nearly every
 * track, finds a track by ISRC directly, and needs no account. A preview URL
 * is signed and expires within the hour, so it is looked up right before it
 * is downloaded and never stored.
 */

export const DEEZER_SERVICE = 'deezer';

/** Deezer reports errors as a 200 with this body. */
interface DeezerError {
	error?: { type?: string; message?: string; code?: number };
}

interface DeezerTrack {
	id: number;
	title: string;
	duration: number;
	preview?: string;
	readable?: boolean;
	artist?: { name?: string };
}

export interface Preview {
	deezerTrackId: number;
	matchedBy: 'isrc' | 'search';
	url: string;
}

/** What a search needs when the ISRC finds nothing. */
export interface Wanted {
	isrc: string;
	title: string;
	artist: string | null;
	durationMs: number;
}

/** Deezer's "no data": the id is unknown, which is an answer, not a failure. */
const NO_DATA = 800;
/** "Quota limit exceeded": 50 requests per 5 seconds, counted per IP. */
const QUOTA = 4;

async function get<T>(path: string): Promise<T | null> {
	await pace(DEEZER_SERVICE);
	const res = await fetch(`${config.analysis.deezerUrl}${path}`, {
		headers: { Accept: 'application/json' }
	});
	if (res.status === 429 || res.status >= 500) {
		throw new ServiceBlocked(DEEZER_SERVICE, await penalize(DEEZER_SERVICE, 60));
	}
	if (!res.ok) throw new Error(`Deezer ${res.status} on ${path}`);
	const body = (await res.json()) as T & DeezerError;
	if (body.error) {
		if (body.error.code === NO_DATA) return null;
		if (body.error.code === QUOTA) {
			throw new ServiceBlocked(DEEZER_SERVICE, await penalize(DEEZER_SERVICE, 10));
		}
		throw new Error(`Deezer error ${body.error.code} on ${path}: ${body.error.message}`);
	}
	return body;
}

/** Lowercased letters and digits, so "Get Busy - Odd Mob Club Mix" meets "Get Busy (Odd Mob Club Mix)". */
const norm = (s: string) =>
	s
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, '');

const playable = (t: DeezerTrack | null): t is DeezerTrack & { preview: string } =>
	Boolean(t?.preview) && t?.readable !== false;

/**
 * The preview of a recording: by its ISRC, else by a search that has to agree
 * on the title, the first artist and the length to within three seconds. The
 * search is strict on purpose — measuring the wrong mix of a song is worse
 * than not measuring it.
 */
export async function findPreview(w: Wanted): Promise<Preview | null> {
	const byIsrc = await get<DeezerTrack>(`/track/isrc:${encodeURIComponent(w.isrc)}`);
	if (playable(byIsrc)) return { deezerTrackId: byIsrc.id, matchedBy: 'isrc', url: byIsrc.preview };
	if (!w.artist) return null;

	const q = `artist:"${w.artist.replaceAll('"', '')}" track:"${w.title.replaceAll('"', '')}"`;
	const found = await get<{ data?: DeezerTrack[] }>(`/search?limit=10&q=${encodeURIComponent(q)}`);
	const title = norm(w.title);
	const artist = norm(w.artist);
	const hit = (found?.data ?? []).find(
		(t) =>
			playable(t) &&
			norm(t.title) === title &&
			norm(t.artist?.name ?? '') === artist &&
			Math.abs(t.duration * 1000 - w.durationMs) <= 3000
	);
	return hit?.preview ? { deezerTrackId: hit.id, matchedBy: 'search', url: hit.preview } : null;
}

/**
 * The preview's bytes, minus the ID3v2 tag in front of them.
 *
 * Deezer prefixes every preview with an empty ID3v2.4 tag that Symphonia
 * (rbxport's decoder) rejects as "out of bounds", so the tag is cut off here:
 * what is left is a plain MPEG stream, which every decoder reads.
 */
export async function downloadPreview(url: string): Promise<Uint8Array> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`preview ${res.status}`);
	return stripId3v2(new Uint8Array(await res.arrayBuffer()));
}

export function stripId3v2(b: Uint8Array): Uint8Array {
	if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return b;
	// The size is "syncsafe": four bytes of seven bits each, header excluded.
	const size = ((b[6]! & 0x7f) << 21) | ((b[7]! & 0x7f) << 14) | ((b[8]! & 0x7f) << 7) | (b[9]! & 0x7f);
	const footer = b[5]! & 0x10 ? 10 : 0;
	return b.subarray(Math.min(b.length, 10 + size + footer));
}
