import { sql } from 'drizzle-orm';
import { config, SPOTIFY_SCOPE_STRING } from '../config.ts';
import { query } from '../db/index.ts';
import { readAuthState } from '../spotify/auth.ts';
import { spotifyFetch } from '../spotify/client.ts';
import { SpotifyApiError, SpotifyNotFound } from '../spotify/errors.ts';

/**
 * Sortify plays the song on screen through Spotify Connect: the Spotify app on
 * the phone is the device, and these calls drive it with the stored grant.
 * Every one goes through `spotifyFetch`, so playback spends from the same
 * bucket as the sync and waits out the same breaker.
 *
 * Which device to use stays the app's decision — it knows which phone it is
 * running on, and it never falls back to a speaker in another room.
 */

export const PLAYBACK_SCOPES = ['user-read-playback-state', 'user-modify-playback-state'] as const;

export class PlaybackScopeError extends Error {
	constructor(readonly missing: string[]) {
		super(`This Spotify authorization cannot control playback (missing ${missing.join(', ')}). Re-authorize Spotidata.`);
		this.name = 'PlaybackScopeError';
	}
}

/** Spotify has no device to play on: the app is closed, or the device asked for is gone. */
export class NoDevice extends Error {
	constructor() {
		super('No Spotify device available. Open Spotify on this phone and try again.');
		this.name = 'NoDevice';
	}
}

export function missingPlaybackScopes(granted: string | null | undefined): string[] {
	const held = new Set((granted ?? '').split(/\s+/).filter(Boolean));
	return PLAYBACK_SCOPES.filter((s) => !held.has(s));
}

async function assertCanPlay(): Promise<void> {
	const auth = await readAuthState();
	const missing = missingPlaybackScopes(auth?.scope);
	if (!auth || auth.needsReauth || missing.length > 0) throw new PlaybackScopeError(missing);
}

export interface Device {
	id: string;
	name: string;
	type: string;
	is_active: boolean;
}

export async function devices(): Promise<Device[]> {
	await assertCanPlay();
	const body = await spotifyFetch<{ devices: Array<Device & { id: string | null; is_restricted?: boolean }> }>(
		'/me/player/devices'
	);
	return (body?.devices ?? [])
		.filter((d) => d.id && !d.is_restricted)
		.map((d) => ({ id: d.id!, name: d.name, type: d.type, is_active: d.is_active }));
}

export interface PlayerState {
	is_playing: boolean;
	progress_ms: number | null;
	track_id: string | null;
	device_id: string | null;
}

/** Null when nothing is playing anywhere. */
export async function state(): Promise<PlayerState | null> {
	await assertCanPlay();
	const body = await spotifyFetch<{
		is_playing: boolean;
		progress_ms: number | null;
		item: { id: string | null } | null;
		device: { id: string | null } | null;
	}>('/me/player');
	if (!body) return null;
	return {
		is_playing: body.is_playing,
		progress_ms: body.progress_ms,
		track_id: body.item?.id ?? null,
		device_id: body.device?.id ?? null
	};
}

/**
 * A player command. Spotify answers 404 when there is no active device (or the
 * one named has gone), which is the app's cue to wake Spotify; and it often
 * answers 502 when the phone is slow to acknowledge a command it then carries
 * out anyway, so a 502 is not an error here — the app's periodic state check
 * corrects things if it really failed. Never resent: a doubled "play" restarts
 * the song.
 */
async function command(path: string, deviceId: string | null, body?: unknown): Promise<void> {
	await assertCanPlay();
	try {
		await spotifyFetch(path, {
			method: 'PUT',
			query: deviceId ? { device_id: deviceId } : undefined,
			body,
			retryServerErrors: false
		});
	} catch (err) {
		if (err instanceof SpotifyNotFound) throw new NoDevice();
		if (err instanceof SpotifyApiError && err.status === 502) return;
		if (err instanceof SpotifyApiError && /no active device/i.test(err.body)) throw new NoDevice();
		throw err;
	}
}

/**
 * Plays a track inside its album, starting partway in. The iOS Spotify app
 * accepts a bare `uris` play but then stops and loads nothing, while an album
 * context with an offset plays reliably.
 */
export async function play(trackId: string, positionMs: number, deviceId: string | null): Promise<void> {
	const rows = await query<{ uri: string; album_uri: string | null }>(sql`
		select st.uri, al.uri as album_uri
		  from spotify_tracks st left join albums al on al.id = st.album_id
		 where st.id = ${trackId}
	`);
	const uri = rows[0]?.uri ?? `spotify:track:${trackId}`;
	const albumUri = rows[0]?.album_uri;
	const position_ms = Math.max(0, Math.round(positionMs));
	await command(
		'/me/player/play',
		deviceId,
		albumUri ? { context_uri: albumUri, offset: { uri }, position_ms } : { uris: [uri], position_ms }
	);
}

export const pause = (deviceId: string | null) => command('/me/player/pause', deviceId);
export const resume = (deviceId: string | null) => command('/me/player/play', deviceId);

export async function seek(positionMs: number, deviceId: string | null): Promise<void> {
	await assertCanPlay();
	try {
		await spotifyFetch('/me/player/seek', {
			method: 'PUT',
			query: { position_ms: Math.max(0, Math.round(positionMs)), device_id: deviceId ?? undefined },
			retryServerErrors: false
		});
	} catch (err) {
		if (err instanceof SpotifyNotFound) throw new NoDevice();
		if (err instanceof SpotifyApiError && err.status === 502) return;
		throw err;
	}
}

/**
 * The link that starts Spotify on the phone so it registers as a Connect
 * device. It is Spotify's app-based authorize screen for this app's client id,
 * which, once the app is authorized, redirects straight back to the caller's
 * URL scheme — so the user never switches back by hand. The code it returns is
 * thrown away; the grant that matters is Spotidata's. The redirect has to be
 * one registered on the Spotify app.
 */
export function wakeUrl(redirectUri: string): string {
	// Percent-encoded, spaces as %20: the Spotify app's parser is not a form decoder.
	const params = Object.entries({
		client_id: config.spotify.clientId,
		response_type: 'code',
		redirect_uri: redirectUri,
		scope: SPOTIFY_SCOPE_STRING
	}).map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
	return `spotify-action://authorize?${params.join('&')}`;
}
