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
		readonly retryAfterSeconds?: number
	) {
		super(`Spotify web player ${status}: ${path}`);
		this.name = 'WebPlayerError';
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
async function fetchSession(trackId: string): Promise<Session> {
	const res = await fetch(EMBED + trackId, { signal: AbortSignal.timeout(TIMEOUT_MS) });
	if (!res.ok) throw new WebPlayerError(res.status, '/embed');
	const html = await res.text();
	const data = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s)?.[1];
	const found = data
		? (JSON.parse(data) as { props?: { pageProps?: { state?: { settings?: { session?: Session } } } } })
				.props?.pageProps?.state?.settings?.session
		: undefined;
	if (!found?.accessToken) {
		// The page changed shape. A 502 says "upstream broke", which is the truth.
		throw new WebPlayerError(502, '/embed (no token in the page)');
	}
	return found;
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
		const res = await fetch(SPCLIENT + path, {
			headers: {
				Authorization: `Bearer ${await token(seedTrackId, attempt > 0)}`,
				Accept: 'application/json'
			},
			signal: AbortSignal.timeout(TIMEOUT_MS)
		});
		if (res.ok) return (await res.json()) as T;
		if (res.status === 404) return null;
		// An expired or revoked session: scrape a fresh one, once.
		if (res.status === 401 && attempt === 0) continue;
		const retryAfter = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
		throw new WebPlayerError(res.status, path, Number.isFinite(retryAfter) ? retryAfter : undefined);
	}
}
