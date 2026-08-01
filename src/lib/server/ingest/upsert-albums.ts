import { inArray, sql } from 'drizzle-orm';
import { albumArtists, albumGenres, albumImages, albums, genres } from '../db/schema/index.ts';
import type { FullAlbum, SimplifiedAlbum } from '../spotify/types.ts';
import { chunkIds, chunkRows, dedupeBy, withTx, type Executor } from './_bulk.ts';
import { upsertSimplifiedArtists } from './upsert-artists.ts';

/** Columns a nested album object can speak for; label/popularity/upc are not among them. */
function simplifiedRow(a: SimplifiedAlbum) {
	return {
		id: a.id,
		name: a.name,
		albumType: a.album_type ?? null,
		releaseDate: a.release_date ?? null,
		releaseDatePrecision: a.release_date_precision ?? null,
		totalTracks: a.total_tracks ?? null,
		availableMarkets: a.available_markets ?? [],
		restrictions: a.restrictions ?? null,
		href: a.href ?? null,
		uri: a.uri,
		externalUrls: a.external_urls ?? {}
	};
}

const simplifiedSet = {
	name: sql`excluded.name`,
	albumType: sql`coalesce(excluded.album_type, ${albums.albumType})`,
	releaseDate: sql`coalesce(excluded.release_date, ${albums.releaseDate})`,
	releaseDatePrecision: sql`coalesce(excluded.release_date_precision, ${albums.releaseDatePrecision})`,
	totalTracks: sql`coalesce(excluded.total_tracks, ${albums.totalTracks})`,
	// Without a market context Spotify answers `[]`; that is silence, not a
	// worldwide takedown, so it must not overwrite a populated list.
	availableMarkets: sql`coalesce(nullif(excluded.available_markets, '{}'::text[]), ${albums.availableMarkets})`,
	restrictions: sql`coalesce(excluded.restrictions, ${albums.restrictions})`,
	href: sql`coalesce(excluded.href, ${albums.href})`,
	uri: sql`coalesce(excluded.uri, ${albums.uri})`,
	externalUrls: sql`coalesce(nullif(excluded.external_urls, '{}'::jsonb), ${albums.externalUrls})`,
	updatedAt: sql`now()`
};

/**
 * Albums nested in a full track. They carry artists and cover art but never
 * label, popularity, UPC, copyrights or genres, so this leaves detail_level
 * and fetched_at alone: the hydration phase keys off them.
 */
export async function upsertSimplifiedAlbums(
	input: SimplifiedAlbum[],
	on?: Executor
): Promise<void> {
	const list = dedupeBy(
		input.filter((a) => a.id),
		(a) => a.id
	);
	if (list.length === 0) return;

	await withTx(on, async (tx) => {
		await upsertSimplifiedArtists(
			list.flatMap((a) => a.artists ?? []),
			tx
		);

		for (const part of chunkRows(list.map(simplifiedRow))) {
			await tx
				.insert(albums)
				.values(part)
				.onConflictDoUpdate({ target: albums.id, set: simplifiedSet });
		}

		await replaceAlbumArtists(tx, list);
		await replaceAlbumImages(tx, list);
	});
}

/** Albums from `/albums?ids=` — adds label, popularity, UPC, copyrights, genres. */
export async function upsertFullAlbums(input: FullAlbum[], on?: Executor): Promise<void> {
	const list = dedupeBy(
		input.filter((a) => a.id),
		(a) => a.id
	);
	if (list.length === 0) return;

	const rows = list.map((a) => ({
		...simplifiedRow(a),
		label: a.label ?? null,
		popularity: a.popularity ?? null,
		upc: a.external_ids?.upc ?? null,
		copyrights: a.copyrights ?? null,
		detailLevel: 'full' as const,
		fetchedAt: new Date()
	}));

	await withTx(on, async (tx) => {
		await upsertSimplifiedArtists(
			list.flatMap((a) => a.artists ?? []),
			tx
		);

		for (const part of chunkRows(rows)) {
			await tx
				.insert(albums)
				.values(part)
				.onConflictDoUpdate({
					target: albums.id,
					set: {
						...simplifiedSet,
						label: sql`coalesce(excluded.label, ${albums.label})`,
						popularity: sql`coalesce(excluded.popularity, ${albums.popularity})`,
						upc: sql`coalesce(excluded.upc, ${albums.upc})`,
						copyrights: sql`coalesce(excluded.copyrights, ${albums.copyrights})`,
						detailLevel: 'full' as const,
						fetchedAt: sql`now()`
					}
				});
		}

		await replaceAlbumArtists(tx, list);
		await replaceAlbumImages(tx, list);
		await replaceAlbumGenres(tx, list);
	});
}

async function replaceAlbumArtists(tx: Executor, list: SimplifiedAlbum[]): Promise<void> {
	const credited = list.filter((a) => a.artists?.length);
	if (credited.length === 0) return;

	for (const ids of chunkIds(credited.map((a) => a.id))) {
		await tx.delete(albumArtists).where(inArray(albumArtists.albumId, ids));
	}

	const rows = dedupeBy(
		credited.flatMap((a) =>
			a.artists.map((artist, position) => ({ albumId: a.id, artistId: artist.id, position }))
		),
		// The PK is (album_id, artist_id): one artist credited twice on the same
		// album would otherwise abort the statement.
		(r) => `${r.albumId} ${r.artistId}`
	);
	for (const part of chunkRows(rows)) {
		await tx
			.insert(albumArtists)
			.values(part)
			.onConflictDoUpdate({
				target: [albumArtists.albumId, albumArtists.artistId],
				set: { position: sql`excluded.position` }
			});
	}
}

async function replaceAlbumImages(tx: Executor, list: SimplifiedAlbum[]): Promise<void> {
	const withImages = list.filter((a) => a.images?.length);
	if (withImages.length === 0) return;

	for (const ids of chunkIds(withImages.map((a) => a.id))) {
		await tx.delete(albumImages).where(inArray(albumImages.albumId, ids));
	}

	const rows = withImages.flatMap((a) =>
		a.images.map((img, position) => ({
			albumId: a.id,
			position,
			url: img.url,
			width: img.width,
			height: img.height
		}))
	);
	for (const part of chunkRows(rows)) {
		await tx
			.insert(albumImages)
			.values(part)
			.onConflictDoUpdate({
				target: [albumImages.albumId, albumImages.position],
				set: { url: sql`excluded.url`, width: sql`excluded.width`, height: sql`excluded.height` }
			});
	}
}

async function replaceAlbumGenres(tx: Executor, list: FullAlbum[]): Promise<void> {
	// Same reasoning as artist genres: `[]` is the API going quiet, not an
	// album shedding its genres.
	const tagged = list.filter((a) => a.genres?.length);
	if (tagged.length === 0) return;

	const names = dedupeBy(
		tagged.flatMap((a) => a.genres ?? []),
		(g) => g
	).map((name) => ({ name }));
	for (const part of chunkRows(names)) {
		await tx.insert(genres).values(part).onConflictDoNothing();
	}

	for (const ids of chunkIds(tagged.map((a) => a.id))) {
		await tx.delete(albumGenres).where(inArray(albumGenres.albumId, ids));
	}

	const pairs = dedupeBy(
		tagged.flatMap((a) => (a.genres ?? []).map((genre) => ({ albumId: a.id, genre }))),
		(p) => `${p.albumId} ${p.genre}`
	);
	for (const part of chunkRows(pairs)) {
		await tx.insert(albumGenres).values(part).onConflictDoNothing();
	}
}
