import { sql } from 'drizzle-orm';
import { db, query } from '../db/index.ts';
import { textArray } from '../db/arrays.ts';
import { upsertPlaylists } from '../ingest/upsert-playlists.ts';
import { getMe } from '../ingest/upsert-users.ts';
import { canWritePlaylists, readAuthState } from '../spotify/auth.ts';
import {
	addPlaylistItems,
	createPlaylist as createSpotifyPlaylist,
	PLAYLIST_ITEMS_PER_REQUEST,
	removePlaylistItems
} from '../spotify/endpoints.ts';
import { PlaylistScopeError } from '../spotify/errors.ts';
import { spotifyLink } from '../../utils/spotify-uri.ts';
import { listPlaylists, type CatalogPlaylist } from './catalog.ts';
import { membershipOf } from './tracks.ts';
import { bumpVersion, invalidateCatalog, noteAdds } from './version.ts';

/**
 * Sortify's changes to Spotify, and the mirror kept in step with them.
 *
 * A write is applied to `playlist_tracks` the moment Spotify accepts it, so the
 * feed never offers a song that was just sorted and the next page is ranked
 * against what the playlists hold now. What the mirror does *not* do is claim
 * the playlist is in sync: `items_synced_snapshot_id` is left at the snapshot
 * the last sync read, so the next sync sees Spotify's new snapshot differ from
 * it and re-reads the playlist in full — which also picks up whatever else
 * changed in it meanwhile, and replaces the rows written here with Spotify's
 * own (positions, added_by) as a sync always does.
 */

export class NotYourPlaylist extends Error {
	constructor() {
		super('Songs can only be added to playlists you own.');
		this.name = 'NotYourPlaylist';
	}
}

async function assertCanWrite(): Promise<void> {
	const auth = await readAuthState();
	if (!auth || auth.needsReauth || !canWritePlaylists(auth.scope)) throw new PlaylistScopeError();
}

async function assertOwned(playlistId: string): Promise<void> {
	const rows = await query<{ n: number }>(sql`
		select count(*)::int as n from playlists where id = ${playlistId} and is_owned and removed_at is null
	`);
	if ((rows[0]?.n ?? 0) === 0) throw new NotYourPlaylist();
}

export interface WriteResult {
	/** Track ids sent to Spotify. */
	tracks: string[];
	/** Recording → owned playlists holding it now, for every recording asked about. */
	membership: Record<string, string[]>;
}

async function recordingsOf(trackIds: string[]): Promise<Map<string, string>> {
	const rows = await query<{ id: string; recording: string }>(sql`
		select id, canonical_track_id as recording
		  from spotify_tracks
		 where id = any(${textArray(trackIds)}) and canonical_track_id is not null
	`);
	return new Map(rows.map((r) => [r.id, r.recording]));
}

/**
 * Adds the songs whose recording is not in the playlist yet, one copy per
 * recording — the album cut being there means the single is too.
 */
export async function addTracks(playlistId: string, trackIds: string[]): Promise<WriteResult> {
	await assertCanWrite();
	await assertOwned(playlistId);
	const recordings = await recordingsOf(trackIds);
	const present = new Set(
		(
			await query<{ recording: string }>(sql`
				select distinct st.canonical_track_id as recording
				  from playlist_tracks pt join spotify_tracks st on st.id = pt.track_id
				 where pt.playlist_id = ${playlistId} and st.canonical_track_id is not null
			`)
		).map((r) => r.recording)
	);
	const wanted: string[] = [];
	for (const id of trackIds) {
		const rec = recordings.get(id);
		if (!rec || present.has(rec)) continue;
		present.add(rec);
		wanted.push(id);
	}

	if (wanted.length > 0) {
		let snapshot: string | null = null;
		for (let i = 0; i < wanted.length; i += PLAYLIST_ITEMS_PER_REQUEST) {
			const slice = wanted.slice(i, i + PLAYLIST_ITEMS_PER_REQUEST);
			snapshot = (await addPlaylistItems(playlistId, slice.map((id) => spotifyLink('track', id, 'uri')))).snapshot_id;
		}
		const me = await getMe();
		await db.transaction(async (tx) => {
			await tx.execute(sql`
				insert into playlist_tracks (playlist_id, position, track_id, added_at, added_by_id)
				select ${playlistId},
				       coalesce((select max(position) from playlist_tracks where playlist_id = ${playlistId}), -1) + t.ord,
				       t.id, now(), ${me?.id ?? null}
				  from unnest(${textArray(wanted)}) with ordinality as t(id, ord)
			`);
			await tx.execute(sql`
				update playlists
				   set snapshot_id = coalesce(${snapshot}, snapshot_id),
				       total_tracks = coalesce(total_tracks, 0) + ${wanted.length},
				       updated_at = now()
				 where id = ${playlistId}
			`);
		});
		bumpVersion();
		noteAdds(wanted.length);
	}

	return { tracks: wanted, membership: await membershipOf([...new Set(recordings.values())]) };
}

/**
 * Removes every copy of these recordings from the playlist, whichever Spotify
 * id each was added under.
 */
export async function removeTracks(playlistId: string, trackIds: string[]): Promise<WriteResult> {
	await assertCanWrite();
	await assertOwned(playlistId);
	const recordings = await recordingsOf(trackIds);
	const rows = await query<{ track_id: string }>(sql`
		select distinct pt.track_id
		  from playlist_tracks pt join spotify_tracks st on st.id = pt.track_id
		 where pt.playlist_id = ${playlistId}
		   and st.canonical_track_id = any(${textArray([...new Set(recordings.values())])})
	`);
	const targets = [...new Set([...rows.map((r) => r.track_id), ...trackIds])];

	let snapshot: string | null = null;
	for (let i = 0; i < targets.length; i += PLAYLIST_ITEMS_PER_REQUEST) {
		const slice = targets.slice(i, i + PLAYLIST_ITEMS_PER_REQUEST);
		snapshot = (await removePlaylistItems(playlistId, slice.map((id) => spotifyLink('track', id, 'uri')))).snapshot_id;
	}
	await db.transaction(async (tx) => {
		const removed = await tx.execute(sql`
			delete from playlist_tracks where playlist_id = ${playlistId} and track_id = any(${textArray(targets)})
		`);
		await tx.execute(sql`
			update playlists
			   set snapshot_id = coalesce(${snapshot}, snapshot_id),
			       total_tracks = greatest(0, coalesce(total_tracks, 0) - ${removed.rowCount ?? 0}),
			       updated_at = now()
			 where id = ${playlistId}
		`);
	});
	bumpVersion();
	return { tracks: targets, membership: await membershipOf([...new Set(recordings.values())]) };
}

/**
 * A new private playlist with these songs in it. It is written into the mirror
 * straight away, so it can be sorted into before the next sync has seen it.
 */
export async function createPlaylist(
	name: string,
	description: string,
	trackIds: string[]
): Promise<{ playlist: CatalogPlaylist; result: WriteResult }> {
	await assertCanWrite();
	const me = await getMe();
	if (!me) throw new Error('No Spotify profile stored yet — run a sync first.');
	const created = await createSpotifyPlaylist(me.id, { name, description, public: false });
	await upsertPlaylists([created], me.id);
	// It is empty at this snapshot, which the mirror's (lack of) rows agrees with.
	await db.execute(sql`
		update playlists
		   set items_synced_snapshot_id = snapshot_id, items_synced_at = now(), total_tracks = 0
		 where id = ${created.id}
	`);
	invalidateCatalog();
	bumpVersion();
	const result = await addTracks(created.id, trackIds);
	const playlist = (await listPlaylists()).find((p) => p.id === created.id);
	if (!playlist) throw new Error('The new playlist did not reach the mirror.');
	return { playlist, result };
}
