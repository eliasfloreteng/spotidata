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
