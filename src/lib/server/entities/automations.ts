import { sql, type SQL } from 'drizzle-orm';
import { anyOf } from '../db/arrays.ts';
import { query } from '../db/index.ts';
import { iso, like, mintSlug, thumb, total, trackArtistsJson, type ArtistRef } from './shared.ts';

/**
 * Playlist automations: source playlists in, one destination playlist out.
 *
 * Everything here is a read over three tables — the automation, its sources,
 * and the ledger of what it has already contributed. The push itself lives in
 * `server/playlists/automations.ts`; this module answers what *would* be
 * pushed, which is the same question the page asks and the same query the run
 * uses, so the preview and the result cannot drift apart.
 */

/** Spotify's ceiling on a playlist. Nothing can be added past it. */
export const MAX_PLAYLIST_ITEMS = 10_000;

export interface Automation {
	id: string;
	name: string;
	description: string | null;
	spotifyPlaylistId: string | null;
	playlistPublic: boolean;
	autoRun: boolean;
	backfill: boolean;
	addedTrackCount: number;
	lastAddedCount: number;
	lastRunAt: string | null;
	lastRunError: string | null;
	createdAt: string;
	updatedAt: string;
	/** Source playlist ids, in the order they were added. */
	sources: string[];
}

const AUTOMATION_COLUMNS = sql`
	       a.id,
	       a.name,
	       a.description,
	       a.spotify_playlist_id as "spotifyPlaylistId",
	       a.playlist_public     as "playlistPublic",
	       a.auto_run            as "autoRun",
	       a.backfill,
	       a.added_track_count   as "addedTrackCount",
	       a.last_added_count    as "lastAddedCount",
	       ${iso('a.last_run_at')} as "lastRunAt",
	       a.last_run_error      as "lastRunError",
	       ${iso('a.created_at')}  as "createdAt",
	       ${iso('a.updated_at')}  as "updatedAt",
	       coalesce((select array_agg(s.playlist_id order by s.added_at, s.playlist_id)
	                   from automation_sources s
	                  where s.automation_id = a.id), '{}'::text[]) as sources`;

export interface AutomationSummary extends Automation {
	/** Tracks in the sources this automation has never accounted for. */
	pending: number;
	/** Names of the source playlists the mirror knows, for the card. */
	sourceNames: string[];
}

export async function listAutomations(): Promise<AutomationSummary[]> {
	return query<AutomationSummary>(sql`
		select ${AUTOMATION_COLUMNS},
		       (select count(*)::int from (${candidates(sql`a.id`)}) c) as pending,
		       coalesce((select array_agg(p.name order by s.added_at, s.playlist_id)
		                   from automation_sources s
		                   join playlists p on p.id = s.playlist_id
		                  where s.automation_id = a.id), '{}'::text[]) as "sourceNames"
		  from playlist_automations a
		 order by a.updated_at desc
	`);
}

export async function getAutomation(id: string): Promise<Automation | null> {
	const rows = await query<Automation>(sql`
		select ${AUTOMATION_COLUMNS} from playlist_automations a where a.id = ${id}
	`);
	return rows[0] ?? null;
}

// ------------------------------------------------------------------ sources

export interface SourceRow {
	playlistId: string;
	/** Null while the playlist has not been ingested yet — `label` carries the name until then. */
	name: string | null;
	label: string | null;
	ownerName: string | null;
	isOwned: boolean | null;
	cover: string | null;
	/** Items stored locally. Zero for a playlist the mirror has metadata for but no items. */
	tracks: number;
	itemsSyncedAt: string | null;
	addedAt: string;
	/** Tracks this source has contributed so far. */
	contributed: number;
}

export async function automationSources(id: string): Promise<SourceRow[]> {
	return query<SourceRow>(sql`
		select s.playlist_id                  as "playlistId",
		       p.name,
		       s.label,
		       u.display_name                 as "ownerName",
		       p.is_owned                     as "isOwned",
		       ${thumb('playlist_images', 'playlist_id', 's.playlist_id')} as cover,
		       (select count(*)::int from playlist_tracks pt where pt.playlist_id = s.playlist_id) as tracks,
		       ${iso('p.items_synced_at')}    as "itemsSyncedAt",
		       ${iso('s.added_at')}           as "addedAt",
		       (select count(*)::int from automation_added_tracks t
		         where t.automation_id = s.automation_id
		           and t.source_playlist_id = s.playlist_id
		           and t.origin = 'added')    as contributed
		  from automation_sources s
		  left join playlists p on p.id = s.playlist_id
		  left join spotify_users u on u.id = p.owner_id
		 where s.automation_id = ${id}
		 order by s.added_at, s.playlist_id
	`);
}

/** Every playlist the mirror knows, for the picker. Owned first: those are the folders. */
export async function pickablePlaylists(): Promise<
	Array<{ id: string; name: string; ownerName: string | null; isOwned: boolean; tracks: number }>
> {
	return query<{ id: string; name: string; ownerName: string | null; isOwned: boolean; tracks: number }>(sql`
		select p.id,
		       p.name,
		       u.display_name as "ownerName",
		       p.is_owned     as "isOwned",
		       (select count(*)::int from playlist_tracks pt where pt.playlist_id = p.id) as tracks
		  from playlists p
		  left join spotify_users u on u.id = p.owner_id
		 where p.removed_at is null
		 order by p.is_owned desc, p.name
	`);
}

// --------------------------------------------------------------- candidates

/**
 * What the sources hold that the automation has not accounted for — the
 * definition of "would be added next run".
 *
 * Two things make this more than a set difference. The DISTINCT ON collapses a
 * recording that sits in three different source playlists (and under three
 * different Spotify ids) to the one copy that entered a source first, so the
 * destination gets one of each rather than one per source. And the NOT EXISTS
 * reads the ledger by BOTH ids: a track the automation added last week under
 * its single release must not come back as the album cut.
 *
 * The ledger — not the playlist's current contents — is what is subtracted
 * here. That is what makes a manual removal permanent.
 */
function candidates(automationId: SQL | string): SQL {
	const id = typeof automationId === 'string' ? sql`${automationId}` : automationId;
	return sql`
		select distinct on (coalesce(st.canonical_track_id, pt.track_id))
		       pt.track_id           as "trackId",
		       st.canonical_track_id as "canonicalTrackId",
		       pt.playlist_id        as "sourcePlaylistId",
		       pt.added_at           as "addedAt"
		  from playlist_tracks pt
		  join automation_sources s
		    on s.automation_id = ${id} and s.playlist_id = pt.playlist_id
		  join spotify_tracks st on st.id = pt.track_id
		 where not pt.is_local
		   and not exists (
		     select 1 from automation_added_tracks t
		      where t.automation_id = ${id}
		        and (t.track_id = pt.track_id
		             or (t.canonical_track_id is not null
		                 and t.canonical_track_id = st.canonical_track_id))
		   )
		 order by coalesce(st.canonical_track_id, pt.track_id),
		          pt.added_at asc nulls last,
		          pt.track_id`;
}

export interface PendingTrack {
	trackId: string;
	canonicalTrackId: string | null;
	sourcePlaylistId: string;
	sourceName: string | null;
	addedAt: string | null;
	title: string;
	durationMs: number | null;
	albumId: string | null;
	albumName: string | null;
	cover: string | null;
	artists: ArtistRef[];
	inLibrary: boolean;
}

/**
 * The tracks a run would append, oldest first.
 *
 * Chronological rather than ranked: an automation is a conveyor belt, so the
 * destination should read in the order things reached the sources — and a run
 * that adds today's five songs must put them after last week's, not interleave
 * them by some score.
 */
export const PENDING_ORDER = sql.raw(`c."addedAt" asc nulls last, c."trackId"`);

export async function pendingTracks(
	id: string,
	opts: { limit: number; offset: number; q?: string }
): Promise<Array<PendingTrack & { total: number }>> {
	const search = opts.q
		? sql` where ${like(sql`st.name`, opts.q)} or ${like(sql`al.name`, opts.q)}`
		: sql``;
	return query<PendingTrack & { total: number }>(sql`
		with c as (${candidates(id)})
		select ${total},
		       c."trackId",
		       c."canonicalTrackId",
		       c."sourcePlaylistId",
		       sp.name                    as "sourceName",
		       ${iso('c."addedAt"')}      as "addedAt",
		       st.name                    as title,
		       st.duration_ms             as "durationMs",
		       al.id                      as "albumId",
		       al.name                    as "albumName",
		       ${thumb('album_images', 'album_id', 'al.id')} as cover,
		       ${trackArtistsJson('c."trackId"')} as artists,
		       (lt.track_id is not null)  as "inLibrary"
		  from c
		  join spotify_tracks st on st.id = c."trackId"
		  left join albums al on al.id = st.album_id
		  left join playlists sp on sp.id = c."sourcePlaylistId"
		  left join library_tracks lt on lt.track_id = c."trackId"
		 ${search}
		 order by ${PENDING_ORDER}
		 limit ${opts.limit} offset ${opts.offset}
	`);
}

/** The same set as the run consumes it: ids, in push order. */
export async function pendingTrackIds(
	id: string,
	limit = MAX_PLAYLIST_ITEMS
): Promise<Array<{ trackId: string; canonicalTrackId: string | null; sourcePlaylistId: string }>> {
	return query<{ trackId: string; canonicalTrackId: string | null; sourcePlaylistId: string }>(sql`
		with c as (${candidates(id)})
		select c."trackId", c."canonicalTrackId", c."sourcePlaylistId"
		  from c
		 order by ${PENDING_ORDER}
		 limit ${limit}
	`);
}

export async function pendingCount(id: string): Promise<number> {
	const rows = await query<{ n: number }>(sql`
		select count(*)::int as n from (${candidates(id)}) c
	`);
	return rows[0]?.n ?? 0;
}

// ------------------------------------------------------------------ ledger

export interface ContributedTrack {
	trackId: string;
	title: string;
	albumId: string | null;
	albumName: string | null;
	cover: string | null;
	artists: ArtistRef[];
	sourcePlaylistId: string | null;
	sourceName: string | null;
	addedAt: string;
	total: number;
}

/** What the automation has put in the playlist, newest first. `seeded` rows never were. */
export async function contributedTracks(
	id: string,
	opts: { limit: number; offset: number }
): Promise<ContributedTrack[]> {
	return query<ContributedTrack>(sql`
		select ${total},
		       t.track_id            as "trackId",
		       coalesce(st.name, '(not in the catalog)') as title,
		       al.id                 as "albumId",
		       al.name               as "albumName",
		       ${thumb('album_images', 'album_id', 'al.id')} as cover,
		       ${trackArtistsJson('t.track_id')} as artists,
		       t.source_playlist_id  as "sourcePlaylistId",
		       sp.name               as "sourceName",
		       ${iso('t.added_at')}  as "addedAt"
		  from automation_added_tracks t
		  left join spotify_tracks st on st.id = t.track_id
		  left join albums al on al.id = st.album_id
		  left join playlists sp on sp.id = t.source_playlist_id
		 where t.automation_id = ${id} and t.origin = 'added'
		 order by t.added_at desc, t.track_id
		 limit ${opts.limit} offset ${opts.offset}
	`);
}

export interface LedgerEntry {
	trackId: string;
	canonicalTrackId: string | null;
	sourcePlaylistId: string | null;
}

/**
 * Records tracks against the automation.
 *
 * `added` rows were pushed to Spotify; `seeded` rows are what a source already
 * held when it was attached to an automation that does not backfill. Both mean
 * the same thing to every later run: accounted for, never offer it again.
 */
export async function recordLedger(
	id: string,
	entries: LedgerEntry[],
	origin: 'added' | 'seeded'
): Promise<void> {
	if (entries.length === 0) return;
	await query(sql`
		insert into automation_added_tracks
		       (automation_id, track_id, canonical_track_id, source_playlist_id, origin)
		select ${id},
		       e->>'trackId',
		       e->>'canonicalTrackId',
		       e->>'sourcePlaylistId',
		       ${origin}
		  from jsonb_array_elements(${JSON.stringify(entries)}::jsonb) e
		    on conflict (automation_id, track_id) do nothing
	`);
}

/** Everything a source currently holds, marked as seen without pushing any of it. */
export async function seedSource(id: string, playlistId: string): Promise<number> {
	const rows = await query<{ n: number }>(sql`
		with inserted as (
		  insert into automation_added_tracks
		         (automation_id, track_id, canonical_track_id, source_playlist_id, origin)
		  select distinct on (coalesce(st.canonical_track_id, pt.track_id))
		         ${id}, pt.track_id, st.canonical_track_id, pt.playlist_id, 'seeded'
		    from playlist_tracks pt
		    join spotify_tracks st on st.id = pt.track_id
		   where pt.playlist_id = ${playlistId} and not pt.is_local
		   order by coalesce(st.canonical_track_id, pt.track_id), pt.added_at asc nulls last, pt.track_id
		      on conflict (automation_id, track_id) do nothing
		  returning 1
		)
		select count(*)::int as n from inserted
	`);
	return rows[0]?.n ?? 0;
}

// --------------------------------------------------------------------- CRUD

export async function createAutomation(
	name: string,
	opts: { backfill?: boolean } = {}
): Promise<string> {
	const id = await mintSlug('playlist_automations', name, 'automation');
	await query(sql`
		insert into playlist_automations (id, name, backfill)
		values (${id}, ${name}, ${opts.backfill ?? true})
	`);
	return id;
}

/**
 * Attaches a source. A no-backfill automation seeds it in the same breath, so
 * "only what arrives from now on" means from the moment the source was added
 * rather than the moment the automation was created — attaching a playlist you
 * have curated for years should not empty it into the destination.
 */
export async function addSource(id: string, playlistId: string, label?: string | null): Promise<void> {
	await query(sql`
		insert into automation_sources (automation_id, playlist_id, label)
		values (${id}, ${playlistId}, ${label ?? null})
		    on conflict (automation_id, playlist_id)
		    do update set label = coalesce(excluded.label, automation_sources.label)
	`);
	const rows = await query<{ backfill: boolean }>(sql`
		select backfill from playlist_automations where id = ${id}
	`);
	if (rows[0] && !rows[0].backfill) await seedSource(id, playlistId);
	await touch(id);
}

/**
 * Detaches a source. The ledger keeps its rows: those tracks are in the
 * destination playlist, and forgetting they came from here would offer them
 * again the moment the source is re-attached.
 */
export async function removeSource(id: string, playlistId: string): Promise<void> {
	await query(sql`
		delete from automation_sources where automation_id = ${id} and playlist_id = ${playlistId}
	`);
	await touch(id);
}

export async function updateAutomation(
	id: string,
	patch: {
		name?: string;
		description?: string | null;
		autoRun?: boolean;
		backfill?: boolean;
		playlistPublic?: boolean;
	}
): Promise<void> {
	const sets: SQL[] = [];
	if (patch.name !== undefined) sets.push(sql`name = ${patch.name}`);
	if (patch.description !== undefined) sets.push(sql`description = ${patch.description}`);
	if (patch.autoRun !== undefined) sets.push(sql`auto_run = ${patch.autoRun}`);
	if (patch.backfill !== undefined) sets.push(sql`backfill = ${patch.backfill}`);
	if (patch.playlistPublic !== undefined) sets.push(sql`playlist_public = ${patch.playlistPublic}`);
	if (sets.length === 0) return;
	await query(sql`
		update playlist_automations set ${sql.join(sets, sql`, `)}, updated_at = now() where id = ${id}
	`);
}

export async function deleteAutomation(id: string): Promise<void> {
	await query(sql`delete from playlist_automations where id = ${id}`);
}

/**
 * Forgets the destination playlist without touching it — the copy on Spotify
 * stays exactly as it is and simply stops being fed. The ledger goes with it:
 * the next playlist starts empty, so everything the sources hold is offered to
 * it again.
 */
export async function unlinkPlaylist(id: string): Promise<void> {
	await query(sql`delete from automation_added_tracks where automation_id = ${id}`);
	await query(sql`
		update playlist_automations
		   set spotify_playlist_id = null, added_track_count = 0, last_added_count = 0,
		       last_run_error = null, updated_at = now()
		 where id = ${id}
	`);
}

/**
 * Points the automation at a playlist that already exists.
 *
 * The alternative to letting it create one, and the reason the ledger starts
 * empty rather than pre-seeded: the first run reads what the playlist holds and
 * records that as accounted for, which is the same path an automation follows
 * every time somebody adds a track by hand. Nothing here is written to Spotify.
 */
export async function linkPlaylist(id: string, playlistId: string): Promise<void> {
	await query(sql`
		update playlist_automations
		   set spotify_playlist_id = ${playlistId}, last_run_error = null, updated_at = now()
		 where id = ${id}
	`);
}

/** Whether any automation already writes to this playlist — a destination is not a shared resource. */
export async function automationForPlaylist(playlistId: string): Promise<string | null> {
	const rows = await query<{ id: string }>(sql`
		select id from playlist_automations where spotify_playlist_id = ${playlistId} limit 1
	`);
	return rows[0]?.id ?? null;
}

/** Playlist names for ids the picker did not supply — pasted links, mostly. */
export async function playlistNames(ids: string[]): Promise<Map<string, string>> {
	if (ids.length === 0) return new Map();
	const rows = await query<{ id: string; name: string }>(sql`
		select id, name from playlists where id = ${anyOf(ids)}
	`);
	return new Map(rows.map((r) => [r.id, r.name]));
}

const touch = (id: string) =>
	query(sql`update playlist_automations set updated_at = now() where id = ${id}`);
