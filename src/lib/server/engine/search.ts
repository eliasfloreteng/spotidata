import { search } from '../spotify/endpoints.ts';
import { pickImage } from '../spotify/images.ts';
import { isFullTrack, type FullTrack, type Paging } from '../spotify/types.ts';

/**
 * Spotify's catalog, for Deckhand's Get Music. Searching Spotify rather than a
 * second catalog means a result carries the library's own track ids and
 * ISRCs, which is how the engine tells what the folder already holds and what
 * its download sources are asked for. Live, through `spotifyFetch` and so the
 * one rate limiter; nothing is stored.
 */

export interface CatalogTrack {
	id: string;
	title: string;
	artists: string[];
	album: string;
	isrc?: string;
	duration_ms: number;
	/** About 300 px. */
	cover?: string;
	explicit: boolean;
}

/** Spotify's own ceiling for one page of search results. */
export const SEARCH_MAX = 50;

export async function searchCatalog(q: string, limit: number): Promise<CatalogTrack[]> {
	const n = Math.max(1, Math.min(SEARCH_MAX, Math.floor(limit) || 1));
	const page = (await search(q, ['track'], n)).tracks as Paging<FullTrack | null> | undefined;
	return (page?.items ?? [])
		.filter((t): t is FullTrack & { id: string } => isFullTrack(t) && t.id !== null)
		.map(toCatalogTrack);
}

/** A track of Spotify's, as the engine is handed it. */
export function toCatalogTrack(t: FullTrack & { id: string }): CatalogTrack {
	return {
		id: t.id,
		title: t.name,
		artists: t.artists.map((a) => a.name).filter(Boolean),
		album: t.album?.name ?? '',
		isrc: t.external_ids?.isrc?.trim().toUpperCase() || undefined,
		duration_ms: t.duration_ms,
		cover: pickImage(t.album?.images),
		explicit: t.explicit ?? false
	};
}
