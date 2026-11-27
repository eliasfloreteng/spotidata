/**
 * The few things only Spotify's own clients can reach, read the way its embed
 * player reads them.
 *
 * Since November 2024 the Web API hides every Spotify-owned playlist from
 * apps like this one: search returns `null` in their place and
 * `GET /playlists/{id}` answers 404. Song radio is one of those playlists, and
 * nothing in the Web API says which playlist is a song's radio in the first
 * place. Spotify's internal API (`spclient`) knows both, and it accepts the
 * anonymous token the embed widget is served with: no account, no cookie, no
 * scope. So this is deliberately not the user's token, and it does not spend
 * from the Postgres bucket — that bucket is the Web API's quota, and this is a
 * different host with a different one.
 *
 * Being an anonymous web-player session, what comes back is the radio anyone
 * would get, not one tuned to this account.
 */

const EMBED = 'https://open.spotify.com/embed/track/';
const SPCLIENT = 'https://spclient.wg.spotify.com';

/** Refetch this long before Spotify's stated expiry, so a slow call cannot outlive it. */
const EXPIRY_MARGIN_MS = 60_000;
const TIMEOUT_MS = 10_000;

/** Spotify's internal API refused or could not be reached. */
export class WebPlayerError extends Error {
	constructor(
		readonly status: number,
		readonly path: string,
		/** Seconds, when Spotify said how long to wait. */
		readonly retryAfterSeconds?: number,
		options?: ErrorOptions
	) {
		super(`Spotify web player ${status}: ${path}`, options);
		this.name = 'WebPlayerError';
	}
}

/**
 * Runs one exchange with Spotify, so that a dead connection, a timeout or a
 * body that is not what it should be surfaces as Spotify's failure (502, or
 * 504 for a timeout) rather than escaping as an unexplained 500.
 */
async function upstream<T>(path: string, exchange: () => Promise<T>): Promise<T> {
	try {
		return await exchange();
	} catch (err) {
		if (err instanceof WebPlayerError) throw err;
		const timedOut = err instanceof Error && err.name === 'TimeoutError';
		throw new WebPlayerError(timedOut ? 504 : 502, path, undefined, { cause: err });
	}
}

interface Session {
	accessToken: string;
	accessTokenExpirationTimestampMs: number;
}

let session: Session | null = null;
let pending: Promise<Session> | null = null;

/**
 * An anonymous token, from the `__NEXT_DATA__` an embed page ships with. Any
 * track's embed page carries one; the caller's own seed saves knowing a
 * track id that is sure to exist.
 */
function fetchSession(trackId: string): Promise<Session> {
	return upstream('/embed', async () => {
		const res = await fetch(EMBED + trackId, { signal: AbortSignal.timeout(TIMEOUT_MS) });
		if (!res.ok) throw new WebPlayerError(res.status, '/embed');
		const html = await res.text();
		const data = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s)?.[1];
		const page = data
			? (JSON.parse(data) as {
					props?: { pageProps?: { status?: number; state?: { settings?: { session?: Session } } } };
				}).props?.pageProps
			: undefined;
		// An unknown track is a 200 carrying a "Page not found" page, and no token.
		if (page?.status === 404) throw new WebPlayerError(404, '/embed');
		const found = page?.state?.settings?.session;
		if (!found?.accessToken) {
			// The page changed shape. A 502 says "upstream broke", which is the truth.
			throw new WebPlayerError(502, '/embed (no token in the page)');
		}
		return found;
	});
}

async function token(trackId: string, renew = false): Promise<string> {
	if (renew) session = null;
	if (session && session.accessTokenExpirationTimestampMs - EXPIRY_MARGIN_MS > Date.now()) {
		return session.accessToken;
	}
	// Concurrent callers share one page fetch rather than each scraping their own.
	pending ??= fetchSession(trackId).finally(() => (pending = null));
	session = await pending;
	return session.accessToken;
}

/**
 * GET an spclient path as JSON. `seedTrackId` is any track id that exists,
 * used only if a token has to be fetched. Null on 404.
 */
export async function webPlayerGet<T>(path: string, seedTrackId: string): Promise<T | null> {
	for (let attempt = 0; ; attempt++) {
		const bearer = await token(seedTrackId, attempt > 0);
		const result = await upstream(path, async () => {
			const res = await fetch(SPCLIENT + path, {
				headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' },
				signal: AbortSignal.timeout(TIMEOUT_MS)
			});
			if (res.ok) return { body: (await res.json()) as T };
			if (res.status === 404) return { body: null };
			// An expired or revoked session: scrape a fresh one, once.
			if (res.status === 401 && attempt === 0) return 'renew' as const;
			const retryAfter = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
			throw new WebPlayerError(res.status, path, Number.isFinite(retryAfter) ? retryAfter : undefined);
		});
		if (result !== 'renew') return result.body;
	}
}
