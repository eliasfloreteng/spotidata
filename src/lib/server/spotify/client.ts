import { getAccessToken } from './auth.ts';
import { acquire, penalize, recordCall } from './ratelimit.ts';
import {
	SpotifyApiError,
	SpotifyForbidden,
	SpotifyNotFound,
	SpotifyRateLimited
} from './errors.ts';

const BASE = 'https://api.spotify.com/v1';

/** Caps concurrent sockets independently of the token bucket's pacing. */
class Semaphore {
	#active = 0;
	readonly #queue: Array<() => void> = [];
	constructor(private readonly limit: number) {}

	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.#active >= this.limit) {
			await new Promise<void>((resolve) => this.#queue.push(resolve));
		}
		this.#active++;
		try {
			return await fn();
		} finally {
			this.#active--;
			this.#queue.shift()?.();
		}
	}
}

const semaphore = new Semaphore(8);

/** Longest we will sit on a worker slot waiting for bucket tokens. */
const MAX_INLINE_WAIT_MS = 2000;
const MAX_SERVER_ERROR_RETRIES = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RequestOptions {
	/** Passed straight through as query parameters. */
	query?: Record<string, string | number | undefined>;
	/** Treat 404 as `null` rather than throwing. */
	allowNotFound?: boolean;
	signal?: AbortSignal;
	method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
	/**
	 * JSON request body, for the playlist write path.
	 *
	 * A write costs a token from the same bucket as a read, which is the point
	 * of routing it through here: a playlist push and a running sync throttle
	 * each other rather than racing to the same 429. Retries stay safe because
	 * every write this app makes is idempotent — PUT /playlists/{id}/tracks
	 * replaces, and the POST that follows it appends a slice we recompute.
	 */
	body?: unknown;
}

/**
 * The single chokepoint for every Spotify call.
 *
 * Ordering matters: acquire a token BEFORE taking a semaphore slot, so a
 * throttled caller is not occupying one of the eight sockets while it waits.
 */
export async function spotifyFetch<T>(
	path: string,
	options: RequestOptions = {}
): Promise<T | null> {
	const url = new URL(BASE + path);
	for (const [k, v] of Object.entries(options.query ?? {})) {
		if (v !== undefined) url.searchParams.set(k, String(v));
	}

	for (let serverErrors = 0; ; ) {
		// --- pace ---------------------------------------------------------
		const slot = await acquire(1);
		if (!slot.granted) {
			if (slot.blockedUntil) {
				// The breaker is open. Hand the job back to the queue instead of
				// sleeping — a Retry-After can be hours and must not pin a worker.
				throw new SpotifyRateLimited(
					slot.blockedUntil,
					Math.ceil((slot.blockedUntil.getTime() - Date.now()) / 1000)
				);
			}
			await sleep(Math.min(slot.waitMs, MAX_INLINE_WAIT_MS));
			continue;
		}

		// --- send ---------------------------------------------------------
		const token = await getAccessToken();
		const res = await semaphore.run(() =>
			fetch(url, {
				method: options.method ?? 'GET',
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: 'application/json',
					...(options.body === undefined ? {} : { 'Content-Type': 'application/json' })
				},
				body: options.body === undefined ? undefined : JSON.stringify(options.body),
				signal: options.signal
			})
		);

		if (res.ok) {
			const text = await res.text();
			recordCall('ok', text.length);
			return text ? (JSON.parse(text) as T) : (null as T);
		}

		const body = await res.text();

		switch (res.status) {
			case 429: {
				// Spotify's Retry-After is in seconds and is occasionally measured
				// in hours. Record it, open the breaker for everyone, and bail.
				const retryAfter = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
				const seconds = Number.isFinite(retryAfter) ? retryAfter : 30;
				recordCall('rate_limited');
				const until = await penalize(seconds);
				throw new SpotifyRateLimited(until, seconds);
			}

			case 401: {
				// Access token expired mid-flight. getAccessToken() refreshes on
				// the next pass; only allow one such retry to avoid a loop.
				recordCall('error');
				if (serverErrors++ >= 1) {
					throw new SpotifyApiError(401, path, body);
				}
				continue;
			}

			case 403:
				recordCall('error');
				throw new SpotifyForbidden(path, body);

			case 404:
				recordCall('error');
				if (options.allowNotFound) return null;
				throw new SpotifyNotFound(path);

			default: {
				recordCall('error');
				if (res.status >= 500 && serverErrors < MAX_SERVER_ERROR_RETRIES) {
					serverErrors++;
					// Jittered backoff; 5xx are Spotify's problem, not our quota's.
					await sleep(2 ** serverErrors * 250 + Math.random() * 250);
					continue;
				}
				throw new SpotifyApiError(res.status, path, body);
			}
		}
	}
}

/** Same as spotifyFetch but never returns null for a present resource. */
export async function spotifyGet<T>(path: string, options: RequestOptions = {}): Promise<T> {
	const result = await spotifyFetch<T>(path, options);
	if (result === null) throw new SpotifyNotFound(path);
	return result;
}
