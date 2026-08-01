import type { Task, AddJobsJobSpec } from 'graphile-worker';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import {
	getAlbums,
	getAlbumTracks,
	getArtists,
	getTracks,
	BATCH,
	PAGE
} from '../../spotify/endpoints.ts';
import { upsertFullAlbums } from '../../ingest/upsert-albums.ts';
import type { SimplifiedTrack } from '../../spotify/types.ts';
import { upsertFullArtists } from '../../ingest/upsert-artists.ts';
import { upsertFullTracks, upsertSimplifiedTracks } from '../../ingest/upsert-tracks.ts';
import { storeRaw } from '../../ingest/raw.ts';
import { runLeafTask, seedBatchJobs, spotifyJob } from '../helpers.ts';
import { startPhase, logEvent } from '../phases.ts';
import { PRIORITY_HYDRATE } from '../constants.ts';

interface RunPayload {
	runId: number;
}
interface BatchPayload {
	runId: number;
	ids: string[];
}

// ------------------------------------------------------------------ albums

/**
 * Seeds album fetching for every album a library track came from.
 *
 * `/albums?ids=` takes 20 ids AND embeds each album's first 50 tracks, so this
 * one endpoint covers both "complete the album metadata" and "fetch all its
 * tracks" for the ~99% of albums with ≤50 tracks. 24k albums cost ~1,200
 * requests rather than 24,000.
 */
export const seedAlbums: Task = async (payload, helpers) => {
	const { runId } = payload as RunPayload;

	const { rows } = await db.execute<{ album_id: string }>(sql`
		select distinct st.album_id
		  from library_tracks lt
		  join spotify_tracks st on st.id = lt.track_id
		  left join albums a on a.id = st.album_id
		 where st.album_id is not null
		   and (a.id is null or a.detail_level = 'simplified' or not a.tracks_complete)
	`);
	const ids = rows.map((r) => r.album_id);

	const batches = await seedBatchJobs(helpers, {
		runId,
		task: 'sync:albums-batch',
		ids,
		batchSize: BATCH.albums,
		keyPrefix: `sync:${runId}:alb`
	});

	await startPhase(runId, 'albums', batches);
	await logEvent(runId, 'info', `Albums: ${ids.length} to fetch in ${batches} batches`, null, 'albums');

	if (batches === 0) await helpers.addJob('phase:complete', { runId, phaseKey: 'albums' });
};

export const albumsBatch: Task = async (payload, helpers) => {
	const { runId, ids } = payload as BatchPayload;

	await runLeafTask(helpers, {
		runId,
		phase: 'albums',
		fetch: () => getAlbums(ids),
		write: async (tx, { albums }) => {
			const found = albums.filter((a): a is NonNullable<typeof a> => a !== null);
			if (found.length === 0) return 0;

			await upsertFullAlbums(found, tx);
			await storeRaw('album', found.map((a) => ({ id: a.id, payload: a })), tx);

			let rows = found.length;
			const overflow: string[] = [];

			for (const album of found) {
				const embedded = album.tracks?.items ?? [];
				if (embedded.length > 0) {
					await upsertSimplifiedTracks(embedded, album.id, tx);
					rows += embedded.length;
				}
				// Only the rare long album (box sets, DJ mixes) needs paging.
				if (album.tracks?.next) overflow.push(album.id);
			}

			if (overflow.length > 0) {
				const specs: AddJobsJobSpec[] = overflow.map((albumId) => ({
					identifier: 'sync:album-tracks',
					payload: { runId, albumId },
					jobKey: `sync:${runId}:albt:${albumId}`,
					...spotifyJob
				}));
				await helpers.addJobs(specs, true);
				await tx.execute(sql`
					update sync_phases set total = total + ${overflow.length}
					 where run_id = ${runId} and key = 'album_tracks'
				`);
			}
			return rows;
		}
	});
};

/** Pages the remainder of an album whose track list exceeded 50. */
export const albumTracks: Task = async (payload, helpers) => {
	const { runId, albumId } = payload as { runId: number; albumId: string };

	await runLeafTask(helpers, {
		runId,
		phase: 'album_tracks',
		// Paged up front so a deadlock replay does not re-walk the pagination.
		fetch: async () => {
			const items: SimplifiedTrack[] = [];
			for (let offset = PAGE.albumTracks; ; offset += PAGE.albumTracks) {
				const page = await getAlbumTracks(albumId, offset);
				items.push(...page.items);
				if (page.items.length === 0 || !page.next) break;
			}
			return items;
		},
		write: async (tx, items) => {
			if (items.length === 0) return 0;
			await upsertSimplifiedTracks(items, albumId, tx);
			return items.length;
		}
	});
};

// ----------------------------------------------------------------- artists

/** Genres, images, followers and popularity exist only on the full object. */
export const seedArtists: Task = async (payload, helpers) => {
	const { runId } = payload as RunPayload;

	const { rows } = await db.execute<{ id: string }>(sql`
		select id from artists where detail_level = 'simplified'
	`);
	const ids = rows.map((r) => r.id);

	const batches = await seedBatchJobs(helpers, {
		runId,
		task: 'sync:artists-batch',
		ids,
		batchSize: BATCH.artists,
		keyPrefix: `sync:${runId}:art`
	});

	await startPhase(runId, 'artists', batches);
	await logEvent(runId, 'info', `Artists: ${ids.length} to hydrate in ${batches} batches`, null, 'artists');

	if (batches === 0) await helpers.addJob('phase:complete', { runId, phaseKey: 'artists' });
};

export const artistsBatch: Task = async (payload, helpers) => {
	const { runId, ids } = payload as BatchPayload;

	await runLeafTask(helpers, {
		runId,
		phase: 'artists',
		fetch: () => getArtists(ids),
		write: async (tx, { artists }) => {
			const found = artists.filter((a): a is NonNullable<typeof a> => a !== null);
			if (found.length === 0) return 0;
			await upsertFullArtists(found, tx);
			await storeRaw('artist', found.map((a) => ({ id: a.id, payload: a })), tx);
			return found.length;
		}
	});
};

// --------------------------------------------------------------- hydration

/**
 * Upgrades simplified tracks (the ones that arrived embedded in albums) to
 * full objects, which is the only way to learn their ISRC and popularity.
 *
 * Runs LAST and at low priority: library tracks already arrive full from
 * /me/tracks and playlist items, so every chart is already correct without
 * this. It only sharpens album-completion percentages across editions.
 */
export const seedHydrate: Task = async (payload, helpers) => {
	const { runId } = payload as RunPayload;

	const { rows } = await db.execute<{ id: string }>(sql`
		select id from spotify_tracks
		 where detail_level = 'simplified' and not is_local
	`);
	const ids = rows.map((r) => r.id);

	const batches = await seedBatchJobs(helpers, {
		runId,
		task: 'sync:tracks-hydrate',
		ids,
		batchSize: BATCH.tracks,
		keyPrefix: `sync:${runId}:hyd`,
		priority: PRIORITY_HYDRATE
	});

	await startPhase(runId, 'hydrate', batches);
	await logEvent(runId, 'info', `Hydration: ${ids.length} tracks in ${batches} batches`, null, 'hydrate');

	if (batches === 0) await helpers.addJob('phase:complete', { runId, phaseKey: 'hydrate' });
};

export const tracksHydrate: Task = async (payload, helpers) => {
	const { runId, ids } = payload as BatchPayload;

	await runLeafTask(helpers, {
		runId,
		phase: 'hydrate',
		fetch: () => getTracks(ids),
		write: async (tx, { tracks }) => {
			const found = tracks.filter((t): t is NonNullable<typeof t> => t !== null);
			if (found.length === 0) return 0;
			await upsertFullTracks(found, tx);
			await storeRaw(
				'track',
				found.filter((t) => t.id).map((t) => ({ id: t.id!, payload: t })),
				tx
			);
			return found.length;
		}
	});
};
