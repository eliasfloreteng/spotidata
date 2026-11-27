import { config } from '../config.ts';

/**
 * Deckhand's engine over HTTP, for what only it may do: queue, retry and stop
 * downloads, start and stop keeping a playlist, change its settings. It owns
 * the schema `deckhand` and is the only one writing to it, so every change
 * goes through its API (engine/server/src/api.rs), the same one the apps use.
 *
 * The shapes are the engine's (`engine/model`, `deckhand_model`), as JSON.
 */

/** The engine could not be reached, or failed. */
export class EngineUnavailable extends Error {
	override name = 'EngineUnavailable';
}

/** The engine answered, and said no: `status` is its HTTP status. */
export class EngineRefused extends Error {
	override name = 'EngineRefused';
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
	}
}

/** A track the engine can get: `spotify:<id>`, since the catalog is Spotify's. */
export interface CatalogTrack {
	id: string;
	title: string;
	artists: string[];
	album: string;
	isrc?: string;
	duration_sec: number;
	cover?: string;
	explicit: boolean;
	/** The folder's file that already holds it, from a search. */
	in_library?: string;
}

export type EngineState =
	| 'queued'
	| 'searching'
	| 'downloading'
	| 'finishing'
	| 'waiting'
	| 'done'
	| 'failed'
	| 'cancelled';

export interface Attempt {
	source: string;
	outcome: 'ok' | 'not_found' | 'unavailable' | 'bad_file' | 'needs_you';
	detail?: string;
	ms: number;
}

export interface EngineDownload {
	id: number;
	track: CatalogTrack;
	state: EngineState;
	source?: string;
	received: number;
	total?: number;
	quality?: string;
	file?: string;
	error?: string;
	attempts: Attempt[];
	/** The kept playlist it was got for; absent when asked for by hand. */
	playlist?: string;
	created_ms: number;
	updated_ms: number;
}

export interface SourceHealth {
	id: string;
	source: string;
	host: string;
	rank: number;
	reliability: number;
	speed_kbps?: number;
	latency_ms: number;
	downloads: number;
	resting_until_ms?: number;
	last_error?: string;
	last_ok_ms?: number;
}

export interface Challenge {
	id: string;
	site: string;
	page: string;
	waiting: number;
	solved: boolean;
	expires_ms?: number;
	remaining?: number;
}

export interface DownloadSettings {
	aiff: boolean;
}

export interface EngineDownloads {
	downloads: EngineDownload[];
	sources: SourceHealth[];
	challenges: Challenge[];
	settings: DownloadSettings;
}

export interface KeptPlaylist {
	id: string;
	name: string;
	owner: string;
	owned: boolean;
	image?: string;
	tracks: number;
	selected: boolean;
	linked: boolean;
	file?: string;
	read_ms?: number;
	have: number;
	getting: number;
	missing: number;
	error?: string;
}

export interface SpotifyStatus {
	checking: boolean;
	checked_ms?: number;
	error?: string;
	paused: boolean;
	next_check_ms?: number;
	playlists: KeptPlaylist[];
}

export type ActivityKind =
	| 'kept'
	| 'dropped'
	| 'read'
	| 'changed'
	| 'queued'
	| 'retried'
	| 'landed'
	| 'failed'
	| 'recovered'
	| 'paused'
	| 'resumed';

export interface Activity {
	id: number;
	ms: number;
	kind: ActivityKind;
	playlist?: string;
	name?: string;
	count: number;
	added: number;
	removed: number;
	detail?: string;
}

async function call<T>(method: string, path: string, body?: unknown, timeoutMs = config.engine.timeoutMs): Promise<T> {
	let res: Response;
	try {
		res = await fetch(`${config.engine.url}${path}`, {
			method,
			headers: body === undefined ? undefined : { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs)
		});
	} catch (err) {
		const why = err instanceof Error && err.name === 'TimeoutError' ? 'did not answer in time' : 'is not reachable';
		throw new EngineUnavailable(`Deckhand's engine ${why}.`, { cause: err });
	}
	if (res.status >= 500) {
		throw new EngineUnavailable(`Deckhand's engine failed: ${(await res.text()).slice(0, 300) || res.statusText}`);
	}
	if (!res.ok) {
		const text = (await res.text()).trim();
		throw new EngineRefused(res.status, text || (res.status === 404 ? 'The engine does not know it.' : res.statusText));
	}
	if (res.status === 202 || res.status === 204) return undefined as T;
	return (await res.json()) as T;
}

/** The queue (active, and finished in the last two weeks), the sources' health, the checks and the settings. */
export const engineDownloads = () => call<EngineDownloads>('GET', '/api/downloads');

/** Queues a track, or answers the download already getting it. */
export const queueDownload = (track: CatalogTrack) => call<EngineDownload>('POST', '/api/downloads', { track });

export const retryDownload = (id: number) => call<EngineDownload>('POST', `/api/downloads/${id}/retry`);

/** Stops a download under way, or forgets a finished one. */
export const removeDownload = (id: number) => call<void>('DELETE', `/api/downloads/${id}`);

export const setDownloadSettings = (settings: DownloadSettings) =>
	call<DownloadSettings>('PUT', '/api/downloads/settings', settings);

/** The playlists the engine knows (listed by the account, or kept), and its checks of them. */
export const spotifyStatus = () => call<SpotifyStatus>('GET', '/api/spotify');

export const setChecksPaused = (paused: boolean) => call<SpotifyStatus>('PUT', '/api/spotify', { paused });

/** Has the engine check the kept playlists now, in the background. */
export const checkSpotify = () => call<void>('POST', '/api/spotify/check');

export const spotifyActivity = (limit = 40, playlist?: string) =>
	call<Activity[]>(
		'GET',
		`/api/spotify/activity?limit=${limit}${playlist ? `&playlist=${encodeURIComponent(playlist)}` : ''}`
	);

/**
 * Starts or stops keeping a playlist. One the account lists is picked; any
 * other is kept by its link, which is how the engine keeps a playlist the
 * account does not follow. Reading it can take Spotidata a while, so that
 * call gets longer.
 */
export async function keepPlaylist(id: string, kept: boolean, listed: boolean): Promise<void> {
	if (kept && !listed) {
		await call<KeptPlaylist>('POST', '/api/spotify/playlists', { link: id }, 60_000);
		return;
	}
	await call<KeptPlaylist | undefined>('PUT', `/api/spotify/playlists/${encodeURIComponent(id)}`, {
		selected: kept
	});
}

/** Reads a kept playlist again and retries its failed tracks now. */
export const checkPlaylist = (id: string) => call<void>('POST', `/api/spotify/playlists/${encodeURIComponent(id)}/check`);

/** For a page: what went wrong, said once. */
export function engineError(err: unknown): string {
	if (err instanceof EngineUnavailable || err instanceof EngineRefused) return err.message;
	throw err;
}
