/** Thrown when the breaker is open or a 429 came back. */
export class SpotifyRateLimited extends Error {
	constructor(
		readonly until: Date,
		readonly retryAfterSeconds: number
	) {
		super(`Spotify rate limited until ${until.toISOString()} (${retryAfterSeconds}s)`);
		this.name = 'SpotifyRateLimited';
	}
}

/** 404 — never retried; the entity genuinely does not exist for this user. */
export class SpotifyNotFound extends Error {
	constructor(readonly path: string) {
		super(`Spotify 404: ${path}`);
		this.name = 'SpotifyNotFound';
	}
}

/**
 * The refresh token is dead (400 invalid_grant). Only a full re-authorization
 * fixes this; retrying is pointless and burns attempts.
 */
export class SpotifyAuthExpired extends Error {
	constructor(message = 'Spotify refresh token expired — re-authorization required') {
		super(message);
		this.name = 'SpotifyAuthExpired';
	}
}

/** 403 — endpoint removed, or the playlist is not owned/collaborative. */
export class SpotifyForbidden extends Error {
	constructor(
		readonly path: string,
		readonly body: string
	) {
		super(`Spotify 403: ${path}`);
		this.name = 'SpotifyForbidden';
	}
}

export class SpotifyApiError extends Error {
	constructor(
		readonly status: number,
		readonly path: string,
		readonly body: string
	) {
		super(`Spotify ${status}: ${path} — ${body.slice(0, 200)}`);
		this.name = 'SpotifyApiError';
	}
}

/**
 * The stored grant cannot write playlists: it predates the `playlist-modify-*`
 * scopes, or the user never granted them. Raised before any request is spent,
 * so the page can link to a re-authorization instead of showing a bare 403.
 */
export class PlaylistScopeError extends Error {
	constructor() {
		super(
			'This Spotify authorization cannot modify playlists. Re-authorize to grant playlist access.'
		);
		this.name = 'PlaylistScopeError';
	}
}

/**
 * Spotify's trouble as an HTTP answer a caller can act on: wait (503 with
 * Retry-After), sign in again (503), or give up on that entity (404/403).
 * Plain text, for a client (the engine, a script) to show as it is. Null for
 * anything else, which is a bug to surface rather than translate.
 */
export function spotifyFailure(err: unknown): Response | null {
	const text = (status: number, body: string, headers: Record<string, string> = {}) =>
		new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...headers } });
	if (err instanceof SpotifyRateLimited) {
		return text(503, `Spotify asked for a pause until ${err.until.toISOString()}.`, {
			'retry-after': String(Math.max(1, err.retryAfterSeconds))
		});
	}
	if (err instanceof SpotifyAuthExpired) {
		return text(503, 'The Spotify sign-in has expired. Sign in to Spotidata again.');
	}
	if (err instanceof SpotifyNotFound) return text(404, 'Spotify has no such thing.');
	if (err instanceof SpotifyForbidden) return text(403, 'Spotify will not show that to this app.');
	return null;
}
