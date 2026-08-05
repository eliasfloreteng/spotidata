import { mbFetch } from './client.ts';
import type {
	MbArtist,
	MbIsrcResponse,
	MbRecording,
	MbRelease,
	MbUrlResponse
} from './types.ts';

/**
 * One request per entity, because MusicBrainz has no batch lookup — the
 * closest thing is `browse`, which only works from a *related* entity and
 * cannot take an arbitrary id list. At one request per second that is the
 * budget the whole enrichment design is built around, so every call here is
 * chosen to bring back as much as one `inc` list allows.
 */

/**
 * ISRC → recordings. The single most valuable call in the pipeline: it
 * resolves the recording AND brings back its artist credit (MBIDs included)
 * and tags, so the artist stage starts with most of its work already done.
 *
 * `genres` is not a valid `inc` for this resource — only the recording lookup
 * accepts it — so genres come out of the tag list via `mb_genres` instead.
 */
export async function lookupIsrc(isrc: string): Promise<MbRecording[]> {
	const res = await mbFetch<MbIsrcResponse>(`/isrc/${encodeURIComponent(isrc)}`, {
		inc: ['artist-credits', 'tags']
	});
	return res?.recordings ?? [];
}

/**
 * Full artist: life-span, area of origin, gender, rating and curated genres.
 * Only reachable per-artist, and the reason the artist stage is the most
 * expensive one.
 */
export function lookupArtist(mbid: string): Promise<MbArtist | null> {
	return mbFetch<MbArtist>(`/artist/${mbid}`, { inc: ['genres', 'tags', 'ratings'] });
}

/** Full release: label, barcode, packaging, and the release group above it. */
export function lookupRelease(mbid: string): Promise<MbRelease | null> {
	return mbFetch<MbRelease>(`/release/${mbid}`, {
		inc: ['release-groups', 'labels', 'genres', 'tags']
	});
}

/**
 * The exact-match trick that makes artist and album identification possible at
 * all: MusicBrainz stores streaming links as *relationships*, so asking it
 * about `open.spotify.com/artist/<id>` hands back the artist it belongs to —
 * no fuzzy title matching, no scoring threshold, no wrong answers.
 *
 * Returns null when the link has never been entered, which is most of the long
 * tail.
 */
export async function lookupSpotifyArtistUrl(spotifyArtistId: string) {
	const res = await mbFetch<MbUrlResponse>('/url', {
		query: { resource: `https://open.spotify.com/artist/${spotifyArtistId}` },
		inc: ['artist-rels']
	});
	return res?.relations?.find((r) => r.artist)?.artist ?? null;
}

export async function lookupSpotifyAlbumUrl(spotifyAlbumId: string) {
	const res = await mbFetch<MbUrlResponse>('/url', {
		query: { resource: `https://open.spotify.com/album/${spotifyAlbumId}` },
		inc: ['release-rels']
	});
	return res?.relations?.find((r) => r.release)?.release ?? null;
}

/**
 * The curated genre vocabulary, ~2,000 names, one per line. Fetched whole
 * (two requests) rather than per entity: it is what tells a genre tag from
 * "seen live", and it changes about as often as a dictionary does.
 */
export async function fetchGenreVocabulary(): Promise<string[]> {
	const names: string[] = [];
	const limit = 100;
	for (let offset = 0; ; offset += limit) {
		const page = await mbFetch<{ genres?: { name: string }[]; 'genre-count'?: number }>(
			'/genre/all',
			{ query: { limit, offset } }
		);
		const batch = page?.genres ?? [];
		names.push(...batch.map((g) => g.name));
		if (batch.length < limit) break;
		// A runaway pagination here would spend the whole day's budget.
		if (offset > 10_000) break;
	}
	return names;
}
