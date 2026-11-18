import { spotifyGet } from '../spotify/client.ts';
import { me, getMyPlaylists, PAGE } from '../spotify/endpoints.ts';
import {
	SpotifyAuthExpired,
	SpotifyForbidden,
	SpotifyNotFound,
	SpotifyRateLimited
} from '../spotify/errors.ts';
import {
	isFullTrack,
	type Paging,
	type PlaylistTrackItem,
	type SimplifiedPlaylist,
	type SpotifyImage
} from '../spotify/types.ts';

/**
 * The account's playlists as they are on Spotify right now, for Deckhand (the
 * DJ-stick syncer), which keeps a lossless copy of the ones you pick.
 *
 * Read live rather than from the mirror: the mirror is refreshed twice a day,
 * and a track dropped into a playlist should reach the stick the same evening.
 * Every call goes through `spotifyFetch`, so it spends from the sync's bucket
 * and backs off with it. Callers gate on `snapshot_id` and only ask for a
 * playlist's tracks when it changed, which keeps a check to a handful of
 * requests (one per 50 playlists).
 */

export interface LivePlaylist {
	id: string;
	name: string;
	owner: string;
	/** Yours, rather than one you follow. */
	owned: boolean;
	snapshot_id: string;
	tracks: number;
	/** About 300 px; absent when the playlist has none. */
	image?: string;
}

export interface LiveTrack {
	/** Null for a local file, which has no Spotify id. */
	id: string | null;
	title: string;
	artists: string[];
	album: string;
	isrc?: string;
	duration_ms: number;
	/** About 300 px. */
	cover?: string;
	added_at?: string;
}

export interface LivePlaylistTracks {
	id: string;
	name: string;
	snapshot_id: string;
	tracks: LiveTrack[];
}

let meId: string | null = null;

async function myId(): Promise<string> {
	meId ??= (await me()).id;
	return meId;
}

/** The image closest to 300 px wide, which is what a list row needs. */
function pick(images: SpotifyImage[] | null | undefined): string | undefined {
	if (!images?.length) return undefined;
	const width = (i: SpotifyImage) => i.width ?? 300;
	return [...images].sort((a, b) => Math.abs(width(a) - 300) - Math.abs(width(b) - 300))[0]?.url;
}

export async function livePlaylists(): Promise<LivePlaylist[]> {
	const owner = await myId();
	const out: LivePlaylist[] = [];
	for (let offset = 0; ; offset += PAGE.playlists) {
		const page = await getMyPlaylists(offset);
		for (const p of page.items) {
			if (!p) continue;
			out.push({
				id: p.id,
				name: p.name,
				owner: p.owner?.display_name ?? p.owner?.id ?? '',
				owned: p.owner?.id === owner,
				snapshot_id: p.snapshot_id,
				tracks: p.tracks?.total ?? 0,
				image: pick(p.images)
			});
		}
		if (!page.next || page.items.length === 0) break;
	}
	return out;
}

/**
 * One playlist as the list describes it, by id: any playlist Spotify shows
 * this app, not only the account's. One request; Deckhand checks a playlist
 * added by its link this way.
 */
export async function livePlaylist(id: string): Promise<LivePlaylist> {
	const [owner, p] = await Promise.all([
		myId(),
		spotifyGet<SimplifiedPlaylist>(`/playlists/${id}`, {
			query: { fields: 'id,name,snapshot_id,owner(id,display_name),images,tracks(total)' }
		})
	]);
	return {
		id: p.id,
		name: p.name,
		owner: p.owner?.display_name ?? p.owner?.id ?? '',
		owned: p.owner?.id === owner,
		snapshot_id: p.snapshot_id,
		tracks: p.tracks?.total ?? 0,
		image: pick(p.images)
	};
}

const ITEM_FIELDS =
	'next,items(added_at,is_local,track(type,id,name,duration_ms,external_ids(isrc),artists(name),album(name,images)))';

/** The playlist's tracks in order, episodes and gaps left out. */
export async function livePlaylistTracks(id: string): Promise<LivePlaylistTracks> {
	const head = await spotifyGet<{ id: string; name: string; snapshot_id: string }>(`/playlists/${id}`, {
		query: { fields: 'id,name,snapshot_id' }
	});
	const tracks: LiveTrack[] = [];
	for (let offset = 0; ; offset += PAGE.playlistItems) {
		const page = await spotifyGet<Paging<PlaylistTrackItem>>(`/playlists/${id}/tracks`, {
			query: { limit: PAGE.playlistItems, offset, fields: ITEM_FIELDS }
		});
		for (const item of page.items) {
			const t = item.track;
			if (!isFullTrack(t)) continue;
			tracks.push({
				id: item.is_local ? null : t.id,
				title: t.name,
				artists: t.artists.map((a) => a.name).filter(Boolean),
				album: t.album?.name ?? '',
				isrc: t.external_ids?.isrc?.trim().toUpperCase() || undefined,
				duration_ms: t.duration_ms,
				cover: pick(t.album?.images),
				added_at: item.added_at ?? undefined
			});
		}
		if (!page.next || page.items.length === 0) break;
	}
	return { id: head.id, name: head.name, snapshot_id: head.snapshot_id, tracks };
}

/**
 * Spotify's trouble as an HTTP answer the caller can act on: wait (503 with
 * Retry-After), sign in again (503), or give up on that playlist (404/403).
 */
export function liveFailure(err: unknown): Response | null {
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
	if (err instanceof SpotifyNotFound) return text(404, 'No such playlist.');
	if (err instanceof SpotifyForbidden) return text(403, 'Spotify will not show that playlist to this app.');
	return null;
}
