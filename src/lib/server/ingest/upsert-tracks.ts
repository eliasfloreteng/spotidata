import { inArray, sql } from 'drizzle-orm';
import { spotifyTracks, trackArtists } from '../db/schema/index.ts';
import type { FullTrack, SimplifiedTrack } from '../spotify/types.ts';
import { chunkIds, chunkRows, dedupeBy, withTx, type Executor } from './_bulk.ts';
import { upsertSimplifiedAlbums } from './upsert-albums.ts';
import { upsertSimplifiedArtists } from './upsert-artists.ts';

/** A track with a catalog identity. Local files have `id: null` and no catalog row. */
export type CatalogTrack<T extends SimplifiedTrack> = T & { id: string };

/**
 * Local files carry `is_local: true` and usually a null id; nothing about them
 * is addressable in the catalog, so they only ever live on playlist_tracks.
 */
export function isCatalogTrack<T extends SimplifiedTrack>(track: T): track is CatalogTrack<T> {
	return typeof track.id === 'string' && track.id.length > 0 && !track.is_local;
}

function baseRow(t: CatalogTrack<SimplifiedTrack>, albumId: string | null) {
	return {
		id: t.id,
		name: t.name,
		albumId,
		durationMs: t.duration_ms,
		discNumber: t.disc_number ?? 1,
		trackNumber: t.track_number ?? 0,
		explicit: t.explicit ?? false,
		// Always null since Spotify deprecated it in 2024; stored so the absence
		// is a recorded fact rather than a gap.
		previewUrl: t.preview_url ?? null,
		isLocal: t.is_local ?? false,
		isPlayable: t.is_playable ?? null,
		/** Track relinking: the id this row was substituted for in this market. */
		linkedFromId: t.linked_from?.id ?? null,
		restrictionReason: t.restrictions?.reason ?? null,
		availableMarkets: t.available_markets ?? [],
		href: t.href ?? null,
		uri: t.uri,
		externalUrls: t.external_urls ?? {}
	};
}

const baseSet = {
	name: sql`excluded.name`,
	// A simplified track arrives from an album listing and knows its album; a
	// full one carries it too. Neither may erase a known album.
	albumId: sql`coalesce(excluded.album_id, ${spotifyTracks.albumId})`,
	durationMs: sql`excluded.duration_ms`,
	discNumber: sql`excluded.disc_number`,
	trackNumber: sql`excluded.track_number`,
	explicit: sql`excluded.explicit`,
	previewUrl: sql`coalesce(excluded.preview_url, ${spotifyTracks.previewUrl})`,
	isLocal: sql`excluded.is_local`,
	isPlayable: sql`coalesce(excluded.is_playable, ${spotifyTracks.isPlayable})`,
	linkedFromId: sql`coalesce(excluded.linked_from_id, ${spotifyTracks.linkedFromId})`,
	restrictionReason: sql`coalesce(excluded.restriction_reason, ${spotifyTracks.restrictionReason})`,
	// `[]` means the payload was fetched without a market context, not that the
	// track was pulled worldwide.
	availableMarkets: sql`coalesce(nullif(excluded.available_markets, '{}'::text[]), ${spotifyTracks.availableMarkets})`,
	href: sql`coalesce(excluded.href, ${spotifyTracks.href})`,
	uri: sql`coalesce(excluded.uri, ${spotifyTracks.uri})`,
	externalUrls: sql`coalesce(nullif(excluded.external_urls, '{}'::jsonb), ${spotifyTracks.externalUrls})`,
	updatedAt: sql`now()`
};

/**
 * Tracks from `/tracks?ids=`, saved tracks or playlist items — the only source
 * of ISRC and popularity. The nested album and artists are written at their own
 * (simplified) fidelity, so hydrating them later still has work to do.
 */
export async function upsertFullTracks(input: FullTrack[], on?: Executor): Promise<void> {
	const list = dedupeBy(input.filter(isCatalogTrack), (t) => t.id);
	if (list.length === 0) return;

	const rows = list.map((t) => ({
		...baseRow(t, t.album?.id ?? null),
		popularity: t.popularity ?? null,
		isrc: t.external_ids?.isrc ?? null,
		detailLevel: 'full' as const,
		fetchedAt: new Date()
	}));

	await withTx(on, async (tx) => {
		// Every artist this batch touches — the tracks' own credits AND the
		// nested albums' — goes in ONE sorted statement, before any album row.
		//
		// Writing them in two statements with the album write in between was a
		// deadlock factory: concurrent workers would each hold part of the
		// artist set and wait on the other's. Locking every artist up front, in
		// key order, gives all transactions the same acquisition sequence.
		await upsertSimplifiedArtists(
			[
				...list.flatMap((t) => t.artists ?? []),
				...list.flatMap((t) => t.album?.artists ?? [])
			],
			tx
		);
		// Albums next: spotify_tracks.album_id is a foreign key.
		await upsertSimplifiedAlbums(
			list.map((t) => t.album).filter((a) => a?.id != null),
			tx
		);

		for (const part of chunkRows(rows)) {
			await tx
				.insert(spotifyTracks)
				.values(part)
				.onConflictDoUpdate({
					target: spotifyTracks.id,
					set: {
						...baseSet,
						isrc: sql`coalesce(excluded.isrc, ${spotifyTracks.isrc})`,
						popularity: sql`coalesce(excluded.popularity, ${spotifyTracks.popularity})`,
						detailLevel: 'full' as const,
						fetchedAt: sql`now()`
					}
				});
		}

		await replaceTrackArtists(tx, list);
	});
}

/**
 * Tracks embedded in an album listing. They have no external_ids, popularity or
 * album of their own, so the write mentions neither isrc, popularity,
 * detail_level nor fetched_at: an omitted column leaves the stored value alone,
 * which is what keeps a re-listed album from undoing a hydration.
 */
export async function upsertSimplifiedTracks(
	input: SimplifiedTrack[],
	albumId: string,
	on?: Executor
): Promise<void> {
	const list = dedupeBy(input.filter(isCatalogTrack), (t) => t.id);
	if (list.length === 0) return;

	const rows = list.map((t) => baseRow(t, albumId));

	await withTx(on, async (tx) => {
		await upsertSimplifiedArtists(
			list.flatMap((t) => t.artists ?? []),
			tx
		);

		for (const part of chunkRows(rows)) {
			await tx
				.insert(spotifyTracks)
				.values(part)
				.onConflictDoUpdate({ target: spotifyTracks.id, set: baseSet });
		}

		await replaceTrackArtists(tx, list);
	});
}

async function replaceTrackArtists(
	tx: Executor,
	list: CatalogTrack<SimplifiedTrack>[]
): Promise<void> {
	const credited = list.filter((t) => t.artists?.length);
	if (credited.length === 0) return;

	for (const ids of chunkIds(credited.map((t) => t.id))) {
		await tx.delete(trackArtists).where(inArray(trackArtists.trackId, ids));
	}

	const rows = dedupeBy(
		credited.flatMap((t) =>
			t.artists.map((artist, position) => ({ trackId: t.id, artistId: artist.id, position }))
		),
		// The PK is (track_id, artist_id), and remix credits do repeat an artist.
		(r) => `${r.trackId} ${r.artistId}`
	);
	for (const part of chunkRows(rows)) {
		await tx
			.insert(trackArtists)
			.values(part)
			.onConflictDoUpdate({
				target: [trackArtists.trackId, trackArtists.artistId],
				set: { position: sql`excluded.position` }
			});
	}
}
