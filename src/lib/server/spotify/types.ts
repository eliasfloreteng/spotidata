/**
 * Types written against the payloads actually observed in July 2026, not the
 * published reference — which contradicts itself in several places.
 *
 * Rules learned from probing the live API:
 *  - `preview_url` exists but is ALWAYS null (deprecated in 2024).
 *  - `external_ids.isrc` appears on FULL track objects only.
 *  - Simplified tracks (inside an album) have no external_ids, popularity or
 *    album — hydration through /tracks?ids= is required to get ISRC.
 *  - Nested artists are always simplified: no genres, images or popularity.
 *  - `available_markets` is often `[]`, and `popularity` 0, without a market
 *    context. A user token supplies the country implicitly.
 *  - Playlist items may have `track: null`, or be an episode, or be a local
 *    file whose `track.id` is null.
 */

export interface SpotifyImage {
	url: string;
	height: number | null;
	width: number | null;
}

export interface SimplifiedArtist {
	id: string;
	name: string;
	href?: string;
	uri: string;
	type: 'artist';
	external_urls: Record<string, string>;
}

export interface FullArtist extends SimplifiedArtist {
	/** Frequently `[]` in 2026 — Spotify is winding this field down. */
	genres: string[];
	popularity: number;
	followers: { href: string | null; total: number };
	images: SpotifyImage[];
}

export interface SimplifiedAlbum {
	id: string;
	name: string;
	album_type: 'album' | 'single' | 'compilation';
	album_group?: string;
	artists: SimplifiedArtist[];
	available_markets?: string[];
	external_urls: Record<string, string>;
	href?: string;
	images: SpotifyImage[];
	release_date: string;
	release_date_precision: 'year' | 'month' | 'day';
	total_tracks: number;
	type: 'album';
	uri: string;
	restrictions?: { reason: string };
}

export interface FullAlbum extends SimplifiedAlbum {
	copyrights?: Array<{ text: string; type: string }>;
	external_ids?: { upc?: string; ean?: string; isrc?: string };
	genres?: string[];
	label?: string;
	popularity?: number;
	/** Embedded, up to 50 items, with a `next` cursor for the overflow. */
	tracks?: Paging<SimplifiedTrack>;
}

export interface SimplifiedTrack {
	id: string | null;
	name: string;
	artists: SimplifiedArtist[];
	available_markets?: string[];
	disc_number: number;
	duration_ms: number;
	explicit: boolean;
	external_urls: Record<string, string>;
	href?: string;
	is_local: boolean;
	is_playable?: boolean;
	linked_from?: { id: string; uri: string };
	restrictions?: { reason: string };
	preview_url: string | null;
	track_number: number;
	type: 'track';
	uri: string;
}

export interface FullTrack extends SimplifiedTrack {
	album: SimplifiedAlbum;
	external_ids?: { isrc?: string; ean?: string; upc?: string };
	popularity: number;
}

export interface SpotifyEpisode {
	id: string | null;
	name: string;
	type: 'episode';
	uri: string;
	duration_ms: number;
}

export interface Paging<T> {
	href: string;
	items: T[];
	limit: number;
	next: string | null;
	offset: number;
	previous: string | null;
	total: number;
}

export interface CursorPaging<T> {
	href: string;
	items: T[];
	limit: number;
	next: string | null;
	cursors: { after: string | null; before?: string | null };
	total: number;
}

export interface SavedTrack {
	added_at: string;
	track: FullTrack | null;
}

export interface SavedAlbum {
	added_at: string;
	album: FullAlbum;
}

/**
 * An item of `/me/player/recently-played`.
 *
 * `played_at` is when the stream ENDED, in milliseconds — the same instant the
 * extended export writes to the second, which is what lets the two sources
 * share a dedupe key. The endpoint says nothing about how long the stream ran
 * or why it stopped; only the export knows that.
 */
export interface PlayHistoryItem {
	track: FullTrack;
	played_at: string;
	context: { uri: string; type: string } | null;
}

export interface PublicUser {
	id: string;
	display_name: string | null;
	external_urls: Record<string, string>;
	href?: string;
	uri: string;
	type: 'user';
	followers?: { href: string | null; total: number };
	images?: SpotifyImage[];
}

export interface PrivateUser extends PublicUser {
	email?: string;
	country?: string;
	product?: string;
	explicit_content?: { filter_enabled: boolean; filter_locked: boolean };
}

export interface SimplifiedPlaylist {
	id: string;
	name: string;
	description: string | null;
	collaborative: boolean;
	/** null when the requesting user is not the owner. */
	public: boolean | null;
	snapshot_id: string;
	owner: PublicUser;
	images: SpotifyImage[] | null;
	tracks: { href: string; total: number } | null;
	external_urls: Record<string, string>;
	href?: string;
	uri: string;
	type: 'playlist';
}

export interface PlaylistTrackItem {
	added_at: string | null;
	added_by: PublicUser | null;
	is_local: boolean;
	/** null for removed/unavailable entries; may be an episode. */
	track: FullTrack | SpotifyEpisode | null;
}

export function isFullTrack(x: FullTrack | SpotifyEpisode | null): x is FullTrack {
	return x !== null && x.type === 'track';
}
