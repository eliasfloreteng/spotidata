import type { Task } from 'graphile-worker';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { anyOf } from '../../db/arrays.ts';
import {
	getAlbum,
	getArtist,
	getArtists,
	getPlaylist,
	getPlaylistItems,
	getTrack,
	getTracks,
	chunk,
	BATCH,
	PAGE
} from '../../spotify/endpoints.ts';
import { upsertFullAlbums } from '../../ingest/upsert-albums.ts';
import { upsertFullArtists } from '../../ingest/upsert-artists.ts';
import { upsertFullTracks, upsertSimplifiedTracks } from '../../ingest/upsert-tracks.ts';
import {
	upsertPlaylists,
	clearPlaylistItems,
	replacePlaylistItems
} from '../../ingest/upsert-playlists.ts';
import { getMe } from '../../ingest/upsert-users.ts';
import { storeRaw } from '../../ingest/raw.ts';
import { SpotifyNotFound, SpotifyRateLimited } from '../../spotify/errors.ts';
import { rescheduleForRateLimit } from '../helpers.ts';

export type EntityKind = 'track' | 'album' | 'artist' | 'playlist';

export interface OndemandPayload {
	kind: EntityKind;
	id: string;
	/** 1 = also pull directly related entities so the page fills in behind you. */
	depth?: number;
}

/**
 * Fetches one entity a page asked for and NOTIFYs the waiting request.
 *
 * Page loads never call Spotify directly: routing through the queue keeps a
 * single rate-limit authority (an inline fetch would race the bucket and a
 * 429 from casual browsing would poison a running sync), and gives retries,
 * the breaker, and /sync visibility for free.
 */
export const ondemandEntity: Task = async (payload, helpers) => {
	const { kind, id, depth = 1 } = payload as OndemandPayload;

	try {
		switch (kind) {
			case 'track':
				await fetchTrack(id);
				break;
			case 'album':
				await fetchAlbum(id, depth);
				break;
			case 'artist':
				await fetchArtist(id);
				break;
			case 'playlist':
				await fetchPlaylist(id);
				break;
		}
	} catch (err) {
		if (err instanceof SpotifyRateLimited) {
			await rescheduleForRateLimit(helpers, err);
			return;
		}
		if (err instanceof SpotifyNotFound) {
			// Tell the waiting page so it can render "not found" instead of
			// spinning until its timeout.
			await notify(kind, id, 'missing');
			return;
		}
		throw err;
	}

	// Regroup only what changed; a full refresh over 168k rows would be absurd
	// for one page view.
	await db.execute(sql`select spotidata.refresh_canonical_tracks()`);
	// The album grouping keys on canonical ids and on tracks_complete, so both
	// have to follow the regroup. Together they cost ~0.5s against the ~4s the
	// line above already spends.
	await db.execute(sql`select spotidata.refresh_album_completeness()`);
	await db.execute(sql`select spotidata.refresh_album_groups()`);
	await notify(kind, id, 'ready');
};

async function notify(kind: string, id: string, status: 'ready' | 'missing'): Promise<void> {
	await db.execute(
		sql`select pg_notify('spotidata_ingest', ${JSON.stringify({ kind, id, status })})`
	);
}

async function fetchTrack(id: string): Promise<void> {
	const track = await getTrack(id);
	if (!track) throw new SpotifyNotFound(`/tracks/${id}`);
	await db.transaction(async (tx) => {
		await upsertFullTracks([track], tx);
		if (track.id) await storeRaw('track', [{ id: track.id, payload: track }], tx);
	});
	await hydrateArtists(track.artists.map((a) => a.id));
}

async function fetchAlbum(id: string, depth: number): Promise<void> {
	const album = await getAlbum(id);
	if (!album) throw new SpotifyNotFound(`/albums/${id}`);

	await db.transaction(async (tx) => {
		await upsertFullAlbums([album], tx);
		await storeRaw('album', [{ id: album.id, payload: album }], tx);
		const embedded = album.tracks?.items ?? [];
		if (embedded.length > 0) await upsertSimplifiedTracks(embedded, album.id, tx);
	});

	if (depth < 1) return;

	// Upgrade the embedded simplified tracks to full ones so the page can show
	// ISRC-grouped rows and popularity — 1–3 extra requests for a 50-track album.
	const trackIds = (album.tracks?.items ?? [])
		.map((t) => t.id)
		.filter((t): t is string => Boolean(t));

	for (const batch of chunk(trackIds, BATCH.tracks)) {
		const { tracks } = await getTracks(batch);
		const found = tracks.filter((t): t is NonNullable<typeof t> => t !== null);
		if (found.length === 0) continue;
		await db.transaction(async (tx) => {
			await upsertFullTracks(found, tx);
			await storeRaw(
				'track',
				found.filter((t) => t.id).map((t) => ({ id: t.id!, payload: t })),
				tx
			);
		});
	}

	await hydrateArtists(album.artists.map((a) => a.id));
}

async function fetchArtist(id: string): Promise<void> {
	const artist = await getArtist(id);
	if (!artist) throw new SpotifyNotFound(`/artists/${id}`);
	await db.transaction(async (tx) => {
		await upsertFullArtists([artist], tx);
		await storeRaw('artist', [{ id: artist.id, payload: artist }], tx);
	});
}

async function fetchPlaylist(id: string): Promise<void> {
	const playlist = await getPlaylist(id);
	if (!playlist) throw new SpotifyNotFound(`/playlists/${id}`);

	const me = await getMe();
	await upsertPlaylists([playlist], me?.id ?? '');
	await storeRaw('playlist', [{ id: playlist.id, payload: playlist }]);

	await db.transaction(async (tx) => {
		await clearPlaylistItems(playlist.id, tx);
		for (let offset = 0; ; offset += PAGE.playlistItems) {
			const page = await getPlaylistItems(playlist.id, offset);
			if (page.items.length > 0) {
				await replacePlaylistItems(playlist.id, page.items, offset, tx);
			}
			if (!page.next) break;
		}
		await tx.execute(sql`
			update playlists
			   set items_synced_snapshot_id = snapshot_id, items_synced_at = now()
			 where id = ${playlist.id}
		`);
	});
}

/** Fills in genres/images for any artist we have only as a stub. */
async function hydrateArtists(ids: string[]): Promise<void> {
	if (ids.length === 0) return;
	const { rows } = await db.execute<{ id: string }>(sql`
		select id from artists
		 where id = ${anyOf(ids)} and detail_level = 'simplified'
	`);
	if (rows.length === 0) return;

	for (const batch of chunk(rows.map((r) => r.id), BATCH.artists)) {
		const { artists } = await getArtists(batch);
		const found = artists.filter((a): a is NonNullable<typeof a> => a !== null);
		if (found.length === 0) continue;
		await db.transaction(async (tx) => {
			await upsertFullArtists(found, tx);
			await storeRaw('artist', found.map((a) => ({ id: a.id, payload: a })), tx);
		});
	}
}
