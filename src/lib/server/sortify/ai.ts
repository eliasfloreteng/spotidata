import { sql } from 'drizzle-orm';
import { db, query } from '../db/index.ts';
import { textArray } from '../db/arrays.ts';
import { loadSettings } from '../settings.ts';
import { eligiblePlaylists } from './catalog.ts';
import type { Candidate, Snapshot } from './engine.ts';
import {
	askSongs,
	catalogText,
	judgePlaylist,
	suggestForCards,
	type CardSong,
	type CardSuggestion,
	type Catalog,
	type Verdict
} from './prompts.ts';
import { tracksByIds } from './tracks.ts';
import { currentCatalogVersion } from './version.ts';

/**
 * What the model has said, kept in Postgres so nothing is asked twice, and the
 * single place requests to it are made from — concurrent callers asking about
 * the same song share one request.
 */

export interface AiState {
	/** song → playlist → verdict. */
	fits: Map<string, Map<string, Verdict>>;
	/** Songs the songs → playlists prompt has seen; a playlist it did not pick is a "no". */
	asked: Set<string>;
	/** song → the new playlist the model would start for it. */
	ideas: Map<string, string>;
	/** playlist → songs the playlist → songs prompt has judged, picked or not. */
	judged: Map<string, Set<string>>;
}

export async function loadAiState(): Promise<AiState> {
	const [verdicts, asked] = await Promise.all([
		query<{ song_key: string; playlist_id: string; confidence: number | null; why: string | null; via: string }>(sql`
			select song_key, playlist_id, confidence, why, via from sortify_verdicts
		`),
		query<{ song_key: string; idea: string | null }>(sql`select song_key, idea from sortify_asked_songs`)
	]);
	const state: AiState = { fits: new Map(), asked: new Set(), ideas: new Map(), judged: new Map() };
	for (const v of verdicts) {
		if (v.confidence !== null) {
			const fits = state.fits.get(v.song_key) ?? new Map<string, Verdict>();
			fits.set(v.playlist_id, { confidence: v.confidence, why: v.why ?? '' });
			state.fits.set(v.song_key, fits);
		}
		if (v.via === 'playlist') {
			const judged = state.judged.get(v.playlist_id) ?? new Set<string>();
			judged.add(v.song_key);
			state.judged.set(v.playlist_id, judged);
		}
	}
	for (const a of asked) {
		state.asked.add(a.song_key);
		if (a.idea) state.ideas.set(a.song_key, a.idea);
	}
	return state;
}

export const hasJudged = (state: AiState, song: string, playlistId: string) =>
	state.asked.has(song) || (state.judged.get(playlistId)?.has(song) ?? false);

// --------------------------------------------------------------- catalog

let catalog: (Catalog & { key: string }) | null = null;

/**
 * The catalog is kept byte-identical between requests so the provider can
 * serve it from its prompt cache; see `version.ts` for when it is rebuilt.
 */
export function catalogFor(snapshot: Snapshot): Catalog {
	const key = `${currentCatalogVersion()}:${snapshot.profiles.map((p) => p.id).sort().join(',')}`;
	if (catalog?.key === key) return catalog;
	catalog = { key, text: catalogText(snapshot.profiles), ids: snapshot.profiles.map((p) => p.id) };
	return catalog;
}

// ------------------------------------------------------- songs → playlists

const pendingSongs = new Map<string, Promise<void>>();

export const isPending = (song: string) => pendingSongs.has(song);

/**
 * Asks about the songs not asked about yet, in one request, and waits for any
 * of them another request is already asking about. Songs the model skipped
 * count as asked too, so they are not retried forever.
 */
export async function judgeSongs(candidates: Candidate[], snapshot: Snapshot): Promise<void> {
	const state = await query<{ song_key: string }>(sql`
		select song_key from sortify_asked_songs where song_key = any(${textArray(candidates.map((c) => c.song))})
	`);
	const asked = new Set(state.map((s) => s.song_key));
	const waiting = candidates.filter((c) => pendingSongs.has(c.song)).map((c) => pendingSongs.get(c.song)!);
	const batch = candidates.filter((c) => !asked.has(c.song) && !pendingSongs.has(c.song));

	if (batch.length > 0) {
		const run = (async () => {
			const { sortModel } = await models();
			const answer = await askSongs(batch, catalogFor(snapshot), snapshot.profiles, sortModel);
			await db.transaction(async (tx) => {
				for (const c of batch) {
					await tx.execute(sql`
						insert into sortify_asked_songs (song_key, idea, model)
						values (${c.song}, ${answer.ideas.get(c.song) ?? null}, ${sortModel})
						on conflict (song_key) do update
						   set idea = excluded.idea, model = excluded.model, asked_at = now()
					`);
					for (const [playlistId, v] of answer.fits.get(c.song) ?? []) {
						await tx.execute(sql`
							insert into sortify_verdicts (song_key, playlist_id, confidence, why, via, model)
							values (${c.song}, ${playlistId}, ${v.confidence}, ${v.why}, 'songs', ${sortModel})
							on conflict (song_key, playlist_id) do update
							   set confidence = excluded.confidence, why = excluded.why,
							       via = excluded.via, model = excluded.model, judged_at = now()
						`);
					}
				}
			});
		})();
		const settled = run.finally(() => {
			for (const c of batch) pendingSongs.delete(c.song);
		});
		for (const c of batch) pendingSongs.set(c.song, settled.catch(() => {}));
		waiting.push(settled);
	}
	await Promise.all(waiting);
}

// ------------------------------------------------------- playlist → songs

const pendingPlaylists = new Map<string, Promise<void>>();

export const isPlaylistPending = (id: string) => pendingPlaylists.has(id);

export async function judgeForPlaylist(playlistId: string, batch: Candidate[], snapshot: Snapshot): Promise<void> {
	const profile = snapshot.profileById.get(playlistId);
	if (!profile || batch.length === 0) return;
	const existing = pendingPlaylists.get(playlistId);
	if (existing) return existing;

	const run = (async () => {
		const { sortModel } = await models();
		const fits = await judgePlaylist(profile, batch.slice(0, 30), sortModel);
		await db.transaction(async (tx) => {
			for (const c of batch.slice(0, 30)) {
				const v = fits.get(c.song);
				if (v) {
					await tx.execute(sql`
						insert into sortify_verdicts (song_key, playlist_id, confidence, why, via, model)
						values (${c.song}, ${playlistId}, ${v.confidence}, ${v.why}, 'playlist', ${sortModel})
						on conflict (song_key, playlist_id) do update
						   set confidence = excluded.confidence, why = excluded.why,
						       via = excluded.via, model = excluded.model, judged_at = now()
					`);
				} else {
					// Judged and left out. Kept so the playlist is not asked about it
					// again, without overwriting a fit the songs prompt found.
					await tx.execute(sql`
						insert into sortify_verdicts (song_key, playlist_id, confidence, why, via, model)
						values (${c.song}, ${playlistId}, null, null, 'playlist', ${sortModel})
						on conflict (song_key, playlist_id) do nothing
					`);
				}
			}
		});
	})().finally(() => pendingPlaylists.delete(playlistId));
	pendingPlaylists.set(playlistId, run);
	return run;
}

export async function forgetVerdicts(): Promise<void> {
	await db.transaction(async (tx) => {
		await tx.execute(sql`delete from sortify_verdicts`);
		await tx.execute(sql`delete from sortify_asked_songs`);
	});
	catalog = null;
}

// --------------------------------------------------------------- the feed card

const pendingCards = new Map<string, Promise<void>>();

export interface CardAnswer extends CardSuggestion {
	/** No answer yet, and none was asked for this time (more than a window's worth). */
	pending?: boolean;
}

/**
 * The feed card's suggestions for these tracks, asking the model about the ones
 * it has not seen in batches of ten (two at a time). The first batch of an
 * empty cache is four, so the very first card is quick.
 */
export async function cardSuggestions(trackIds: string[]): Promise<Record<string, CardAnswer>> {
	const ids = [...new Set(trackIds)].slice(0, 40);
	const cached = await readCards(ids);
	const missing = ids.filter((id) => !cached.has(id) && !pendingCards.has(id));
	const waiting = ids.filter((id) => pendingCards.has(id)).map((id) => pendingCards.get(id)!);

	if (missing.length > 0) {
		const empty = (await query<{ n: number }>(sql`select count(*)::int as n from sortify_card_suggestions`))[0]?.n === 0;
		const batches: string[][] = [];
		let rest = missing;
		if (empty) {
			batches.push(rest.slice(0, 4));
			rest = rest.slice(4);
		}
		for (let i = 0; i < rest.length; i += 10) batches.push(rest.slice(i, i + 10));

		const run = (async () => {
			const [{ cardModel }, catalog, tracks] = await Promise.all([models(), cardCatalog(), tracksByIds(missing)]);
			const byId = new Map(tracks.map((t) => [t.id, t]));
			const queue = [...batches];
			const worker = async () => {
				for (let batch = queue.shift(); batch; batch = queue.shift()) {
					const songs: CardSong[] = batch
						.map((id) => byId.get(id))
						.filter((t) => t !== undefined)
						.map((t) => ({
							id: t.id,
							name: t.name,
							artists: t.artists.map((a) => a.name).join(', '),
							album: t.album.name,
							year: t.album.release_date?.slice(0, 4) ?? null,
							genres: t.genres ?? []
						}));
					if (songs.length === 0) continue;
					const answer = await suggestForCards(songs, catalog, cardModel);
					for (const [trackId, s] of answer) {
						await db.execute(sql`
							insert into sortify_card_suggestions (track_id, playlist_ids, ideas, model)
							values (${trackId}, ${textArray(s.playlists)}, ${textArray(s.ideas)}, ${cardModel})
							on conflict (track_id) do update
							   set playlist_ids = excluded.playlist_ids, ideas = excluded.ideas,
							       model = excluded.model, created_at = now()
						`);
					}
				}
			};
			await Promise.all([worker(), worker()]);
		})();
		const settled = run.finally(() => {
			for (const id of missing) pendingCards.delete(id);
		});
		for (const id of missing) pendingCards.set(id, settled.catch(() => {}));
		waiting.push(settled);
	}
	await Promise.all(waiting);

	const done = missing.length > 0 || waiting.length > 0 ? await readCards(ids) : cached;
	return Object.fromEntries(ids.filter((id) => done.has(id)).map((id) => [id, done.get(id)!]));
}

async function readCards(ids: string[]): Promise<Map<string, CardSuggestion>> {
	const rows = await query<{ track_id: string; playlist_ids: string[]; ideas: string[] }>(sql`
		select track_id, playlist_ids, ideas from sortify_card_suggestions where track_id = any(${textArray(ids)})
	`);
	return new Map(rows.map((r) => [r.track_id, { playlists: r.playlist_ids, ideas: r.ideas }]));
}

/** Eligible playlists with the four artists they hold most of, which is all the card prompt needs. */
async function cardCatalog() {
	const playlists = await eligiblePlaylists();
	const rows = await query<{ playlist_id: string; artists: string[] }>(sql`
		select playlist_id, (array_agg(name order by n desc, name))[1:4] as artists
		  from (
		    select pt.playlist_id, a.name, count(*) as n
		      from playlist_tracks pt
		      join track_artists ta on ta.track_id = pt.track_id and ta.position = 0
		      join artists a on a.id = ta.artist_id
		     where pt.playlist_id = any(${textArray(playlists.map((p) => p.id))})
		     group by 1, 2
		  ) x
		 group by 1
	`);
	const top = new Map(rows.map((r) => [r.playlist_id, r.artists]));
	return playlists.map((p) => ({
		id: p.id,
		name: p.name,
		description: p.description,
		total: p.total,
		topArtists: top.get(p.id) ?? []
	}));
}

export async function cardCacheSize(): Promise<number> {
	return (await query<{ n: number }>(sql`select count(*)::int as n from sortify_card_suggestions`))[0]?.n ?? 0;
}

export async function clearCards(): Promise<void> {
	await db.execute(sql`delete from sortify_card_suggestions`);
}

// --------------------------------------------------------------- settings

export async function models() {
	const s = await loadSettings();
	return { cardModel: s['sortify.cardModel'], sortModel: s['sortify.sortModel'], ideasModel: s['sortify.ideasModel'] };
}

export async function spend(): Promise<{ usd: number; requests: number }> {
	const rows = await query<{ usd: number | null; n: number }>(sql`
		select sum(cost_usd) as usd, count(*)::int as n from sortify_ai_requests
	`);
	return { usd: rows[0]?.usd ?? 0, requests: rows[0]?.n ?? 0 };
}
