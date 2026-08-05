import { config } from '../config.ts';
import { MusicbrainzError, ServiceBlocked } from './errors.ts';
import { pace, penalize } from './limiter.ts';
import { getBearerToken } from './oauth.ts';

const BASE = 'https://musicbrainz.org/ws/2';
export const MB_SERVICE = 'musicbrainz';

/**
 * MusicBrainz answers overload with 503 and the same "server is busy" body it
 * has served for twenty years. It is usually gone within a second or two, so
 * a few inline retries beat parking the whole chain — but a run of them means
 * we are the problem, and then the breaker opens for a minute.
 */
const INLINE_RETRIES = 3;
const BUSY_PENALTY_SECONDS = 60;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface MbRequestOptions {
	query?: Record<string, string | number | undefined>;
	/** Include parameters, joined with `+` as the web service expects. */
	inc?: string[];
	signal?: AbortSignal;
}

/**
 * The single chokepoint for every MusicBrainz call.
 *
 * A 404 is a normal answer here — most of what a Spotify library contains has
 * simply never been entered — so it returns null rather than throwing, and the
 * caller records the miss so it is never asked again.
 */
export async function mbFetch<T>(path: string, options: MbRequestOptions = {}): Promise<T | null> {
	const url = new URL(BASE + path);
	url.searchParams.set('fmt', 'json');
	if (options.inc?.length) url.searchParams.set('inc', options.inc.join('+'));
	for (const [k, v] of Object.entries(options.query ?? {})) {
		if (v !== undefined) url.searchParams.set(k, String(v));
	}

	for (let attempt = 0; ; attempt++) {
		await pace(MB_SERVICE);

		const headers: Record<string, string> = {
			// Required, and enforced: MusicBrainz blocks clients that do not
			// identify themselves and a contact address.
			'User-Agent': config.musicbrainz.userAgent,
			Accept: 'application/json'
		};
		const token = await getBearerToken();
		if (token) headers.Authorization = `Bearer ${token}`;

		const res = await fetch(url, { headers, signal: options.signal });

		if (res.ok) return (await res.json()) as T;

		if (res.status === 404) {
			// Drain the body so the socket is reusable.
			await res.text();
			return null;
		}

		const body = await res.text();
		const retryAfter = Number.parseInt(res.headers.get('retry-after') ?? '', 10);

		if (res.status === 429) {
			const seconds = Number.isFinite(retryAfter) ? retryAfter : BUSY_PENALTY_SECONDS;
			throw new ServiceBlocked(MB_SERVICE, await penalize(MB_SERVICE, seconds));
		}

		if (res.status === 503 || res.status >= 500) {
			if (attempt < INLINE_RETRIES) {
				await sleep(1000 * 2 ** attempt + Math.random() * 250);
				continue;
			}
			const seconds = Number.isFinite(retryAfter) ? retryAfter : BUSY_PENALTY_SECONDS;
			throw new ServiceBlocked(MB_SERVICE, await penalize(MB_SERVICE, seconds));
		}

		throw new MusicbrainzError(res.status, path, body);
	}
}
