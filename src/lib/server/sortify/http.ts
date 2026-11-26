import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import {
	PlaylistScopeError,
	SpotifyAuthExpired,
	SpotifyForbidden,
	SpotifyNotFound,
	SpotifyRateLimited
} from '../spotify/errors.ts';
import { OpenRouterError, OpenRouterUnavailable } from './openrouter.ts';
import { NoDevice, PlaybackScopeError, PLAYBACK_SCOPES } from './player.ts';
import { NotEnoughSongs } from './sort.ts';
import { NotYourPlaylist } from './writes.ts';
import { PLAYLIST_WRITE_SCOPES } from '../spotify/auth.ts';

/**
 * How Sortify's API answers when something is in the way. Every error is JSON
 * with a stable `error` code the app switches on and a `message` it can show
 * as is; the ones only a person can fix carry the link that fixes them.
 *
 * - `reauthorize` (403) — the grant lacks a scope this call needs; `missing`
 *   names them and `reauthorize_url` is Spotidata's /auth/login.
 * - `signed_out` (503) — the Spotify grant has expired; same link.
 * - `rate_limited` (503 + Retry-After) — Spotify asked for a pause.
 * - `no_device` (409) — nothing to play on; wake Spotify on the phone.
 * - `model` (502) / `model_unavailable` (503) — OpenRouter failed or has no key.
 */
export function apiError(
	status: number,
	error: string,
	message: string,
	extra: Record<string, unknown> = {},
	headers: Record<string, string> = {}
): Response {
	return new Response(JSON.stringify({ error, message, ...extra }), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', ...headers }
	});
}

export function failure(err: unknown, origin: string): Response {
	const reauthorize_url = `${origin}/auth/login`;
	if (err instanceof PlaylistScopeError) {
		return apiError(403, 'reauthorize', err.message, { missing: [...PLAYLIST_WRITE_SCOPES], reauthorize_url });
	}
	if (err instanceof PlaybackScopeError) {
		return apiError(403, 'reauthorize', err.message, {
			missing: err.missing.length > 0 ? err.missing : [...PLAYBACK_SCOPES],
			reauthorize_url
		});
	}
	if (err instanceof SpotifyAuthExpired) {
		return apiError(503, 'signed_out', 'The Spotify sign-in has expired. Sign in to Spotidata again.', {
			reauthorize_url
		});
	}
	if (err instanceof SpotifyRateLimited) {
		return apiError(
			503,
			'rate_limited',
			`Spotify asked for a pause until ${err.until.toISOString()}.`,
			{ until: err.until.toISOString() },
			{ 'retry-after': String(Math.max(1, err.retryAfterSeconds)) }
		);
	}
	if (err instanceof NoDevice) return apiError(409, 'no_device', err.message);
	if (err instanceof SpotifyNotFound) return apiError(404, 'not_found', 'Spotify does not know that.');
	if (err instanceof SpotifyForbidden) {
		const reason = err.body.match(/"message"\s*:\s*"([^"]+)"/)?.[1];
		return apiError(403, 'forbidden', reason ? `Spotify refused: ${reason}` : 'Spotify refused that.');
	}
	if (err instanceof NotYourPlaylist) return apiError(403, 'not_owned', err.message);
	if (err instanceof NotEnoughSongs) return apiError(409, 'not_enough_songs', err.message);
	if (err instanceof OpenRouterUnavailable) return apiError(503, 'model_unavailable', err.message);
	if (err instanceof OpenRouterError) return apiError(502, 'model', err.message);
	throw err;
}

/** Runs a handler, turning the errors above into answers. */
export async function handle(url: URL, fn: () => Promise<Response>): Promise<Response> {
	try {
		return await fn();
	} catch (err) {
		return failure(err, url.origin);
	}
}

export function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
	});
}

/**
 * A large JSON document, gzipped (adapter-node serves dynamic responses
 * uncompressed, and a liked-songs feed is megabytes) and answering
 * `If-None-Match`, so the app's revalidation of its cached copy costs only the
 * query.
 */
export function bigJson(request: Request, body: string): Response {
	const etag = `"${createHash('sha1').update(body).digest('base64url')}"`;
	const headers: Record<string, string> = {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-cache',
		etag,
		vary: 'accept-encoding'
	};
	if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
	if (/\bgzip\b/.test(request.headers.get('accept-encoding') ?? '')) {
		return new Response(gzipSync(body), { headers: { ...headers, 'content-encoding': 'gzip' } });
	}
	return new Response(body, { headers });
}

/** The play-count threshold from `?min_plays=`, two by default. */
export function minPlays(url: URL): number {
	const n = Number.parseInt(url.searchParams.get('min_plays') ?? '', 10);
	return Number.isFinite(n) && n >= 1 ? Math.min(n, 1000) : 2;
}

export async function body<T>(request: Request): Promise<T> {
	try {
		return (await request.json()) as T;
	} catch {
		return {} as T;
	}
}

export const strings = (v: unknown): string[] =>
	Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
