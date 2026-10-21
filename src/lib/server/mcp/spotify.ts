import { spotifyFetch } from '../spotify/client.ts';
import {
	SpotifyApiError,
	SpotifyAuthExpired,
	SpotifyForbidden,
	SpotifyNotFound,
	SpotifyRateLimited
} from '../spotify/errors.ts';
import { config } from '../config.ts';

/**
 * Passes one arbitrary Web API call through to the user's account.
 *
 * It goes through `spotifyFetch` like every other call this app makes, so it
 * borrows the stored token and its refresh, and it spends from the same
 * bucket as the sync: a burst of tool calls slows the sync down instead of
 * earning both of them a 429. What it can reach is bounded by the scopes the
 * app was granted, not by anything here.
 */

const API_ORIGIN = 'https://api.spotify.com';
const API_PREFIX = '/v1';

export const SPOTIFY_METHODS = ['GET', 'POST', 'PUT', 'DELETE'] as const;
type Method = (typeof SPOTIFY_METHODS)[number];

/** A playlist page is ~300 KB pretty-printed; past this the model is better served by `limit`. */
const MAX_RESPONSE_CHARS = 100_000;

export class SpotifyCallError extends Error {}

/**
 * Accepts "/me/player", "me/player", "/v1/me/player" or a full URL — the last
 * so that a paging object's `next` can be followed as given. Anything that
 * would leave api.spotify.com is refused: the request carries the user's token.
 */
function toPath(input: string): string {
	const url = new URL(input.trim(), `${API_ORIGIN}/`);
	if (url.origin !== API_ORIGIN) {
		throw new SpotifyCallError(`Only ${API_ORIGIN} can be called, not ${url.origin}.`);
	}
	const path = url.pathname.startsWith(`${API_PREFIX}/`)
		? url.pathname.slice(API_PREFIX.length)
		: url.pathname;
	return path + url.search;
}

function describe(err: unknown): string | null {
	if (err instanceof SpotifyForbidden) {
		return `403 Forbidden: ${err.body || '(no body)'}\n\nEither the endpoint is closed to this app, the resource is not the user's to change, or the app's grant lacks the scope. Granted scopes: ${config.spotify.scopes.join(', ')}.`;
	}
	if (err instanceof SpotifyNotFound) return `404 Not Found: ${err.path}`;
	if (err instanceof SpotifyApiError) return `${err.status}: ${err.body || '(no body)'}`;
	if (err instanceof SpotifyRateLimited) {
		return `Rate limited — Spotify asked for a pause until ${err.until.toISOString()}. Every call from this app, the background sync included, is held until then; do not retry before it.`;
	}
	if (err instanceof SpotifyAuthExpired) {
		return 'The Spotify grant has expired. The user has to sign in to Spotidata again before any call can be made.';
	}
	if (err instanceof SpotifyCallError) return err.message;
	return null;
}

export async function callSpotify(
	method: Method,
	path: string,
	query: Record<string, string | number | undefined> | undefined,
	body: unknown
): Promise<{ text: string; isError: boolean }> {
	try {
		const result = await spotifyFetch<unknown>(toPath(path), {
			method,
			query,
			body,
			// A replayed POST appends twice; only a GET is known to be safe to resend.
			retryServerErrors: method === 'GET'
		});
		if (result === null) return { text: `${method} ${path}: OK (no content)`, isError: false };

		const json = JSON.stringify(result);
		if (json.length <= MAX_RESPONSE_CHARS) return { text: json, isError: false };
		return {
			text: `${json.slice(0, MAX_RESPONSE_CHARS)}\n\n[truncated at ${MAX_RESPONSE_CHARS.toLocaleString('en-US')} of ${json.length.toLocaleString('en-US')} characters — narrow the request with \`limit\` or \`fields\`]`,
			isError: false
		};
	} catch (err) {
		// A refused call is a tool result: the model is meant to read Spotify's
		// message and correct the request.
		const message = describe(err);
		if (message === null) throw err;
		return { text: message, isError: true };
	}
}
