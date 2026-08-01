import { spotifyGet, spotifyFetch } from './client.ts';
import type {
	CursorPaging,
	FullAlbum,
	FullArtist,
	FullTrack,
	Paging,
	PlaylistTrackItem,
	PrivateUser,
	SavedAlbum,
	SavedTrack,
	SimplifiedPlaylist,
	SimplifiedTrack
} from './types.ts';

/**
 * Verified batch ceilings (probed live, July 2026). The bulk endpoints are
 * very much alive despite widespread claims to the contrary — this is what
 * keeps a full 10k-track sync at ~6,000 requests instead of ~170,000.
 */
export const BATCH = {
	tracks: 50,
	albums: 20,
	artists: 50
} as const;

export const PAGE = {
	savedTracks: 50,
	savedAlbums: 50,
	playlists: 50,
	playlistItems: 50,
	albumTracks: 50,
	following: 50
} as const;

export const me = () => spotifyGet<PrivateUser>('/me');

export const getSavedTracks = (offset: number, limit = PAGE.savedTracks) =>
	spotifyGet<Paging<SavedTrack>>('/me/tracks', { query: { limit, offset } });

export const getSavedAlbums = (offset: number, limit = PAGE.savedAlbums) =>
	spotifyGet<Paging<SavedAlbum>>('/me/albums', { query: { limit, offset } });

export const getFollowedArtists = (after?: string, limit = PAGE.following) =>
	spotifyGet<{ artists: CursorPaging<FullArtist> }>('/me/following', {
		query: { type: 'artist', limit, after }
	});

export const getMyPlaylists = (offset: number, limit = PAGE.playlists) =>
	spotifyGet<Paging<SimplifiedPlaylist | null>>('/me/playlists', { query: { limit, offset } });

export const getPlaylist = (id: string) =>
	spotifyFetch<SimplifiedPlaylist>(`/playlists/${id}`, { allowNotFound: true });

export const getPlaylistItems = (id: string, offset: number, limit = PAGE.playlistItems) =>
	spotifyGet<Paging<PlaylistTrackItem>>(`/playlists/${id}/tracks`, {
		query: { limit, offset, additional_types: 'track,episode' }
	});

/** Up to 50 ids. Null entries come back for ids Spotify no longer serves. */
export const getTracks = (ids: string[]) =>
	spotifyGet<{ tracks: Array<FullTrack | null> }>('/tracks', {
		query: { ids: ids.join(',') }
	});

export const getTrack = (id: string) =>
	spotifyFetch<FullTrack>(`/tracks/${id}`, { allowNotFound: true });

/**
 * Up to 20 ids. Each album embeds its first 50 tracks, so this single call
 * also yields the track rows — no follow-up request unless total_tracks > 50.
 */
export const getAlbums = (ids: string[]) =>
	spotifyGet<{ albums: Array<FullAlbum | null> }>('/albums', {
		query: { ids: ids.join(',') }
	});

export const getAlbum = (id: string) =>
	spotifyFetch<FullAlbum>(`/albums/${id}`, { allowNotFound: true });

export const getAlbumTracks = (id: string, offset: number, limit = PAGE.albumTracks) =>
	spotifyGet<Paging<SimplifiedTrack>>(`/albums/${id}/tracks`, { query: { limit, offset } });

/** Up to 50 ids. The only source of genres and images for an artist. */
export const getArtists = (ids: string[]) =>
	spotifyGet<{ artists: Array<FullArtist | null> }>('/artists', {
		query: { ids: ids.join(',') }
	});

export const getArtist = (id: string) =>
	spotifyFetch<FullArtist>(`/artists/${id}`, { allowNotFound: true });

export const getArtistAlbums = (id: string, offset: number, limit = 50) =>
	spotifyGet<Paging<FullAlbum>>(`/artists/${id}/albums`, {
		query: { limit, offset, include_groups: 'album,single,compilation,appears_on' }
	});

export const getArtistTopTracks = (id: string) =>
	spotifyFetch<{ tracks: FullTrack[] }>(`/artists/${id}/top-tracks`, { allowNotFound: true });

export const search = (q: string, types: string[], limit = 20) =>
	spotifyGet<Record<string, Paging<unknown>>>('/search', {
		query: { q, type: types.join(','), limit }
	});

/** Splits an id list into API-sized batches. */
export function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}
