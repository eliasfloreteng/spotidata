import { sql } from 'drizzle-orm';
import { db, query } from '../db/index.ts';
import { textArray } from '../db/arrays.ts';
import { listPlaylists } from './catalog.ts';
import {
	hasJudged,
	isPending,
	isPlaylistPending,
	judgeForPlaylist,
	judgeSongs,
	loadAiState,
	models,
	type AiState
} from './ai.ts';
import { getSnapshot, profileContains, type Candidate, type ObjectiveFit, type Snapshot } from './engine.ts';
import { proposePlaylists, topGenres, type Verdict } from './prompts.ts';
import { tracksByIds, type SortifyTrack } from './tracks.ts';
import { addTracks } from './writes.ts';

/**
 * The sort mode: songs worth sorting, most played and most left out first, a
 * page at a time, each with suggested playlists to accept or tweak; filling
 * one playlist; and starting new ones for what fits nowhere.
 *
 * A suggestion merges the data's match and the model's verdict. The model's
 * word counts for more, and a playlist the model looked at and passed over is
 * marked down — that is how "the model said no" reaches the ranking without the
 * model having to say it about every playlist.
 */

export const PAGE_SIZE = 8;

export interface Decisions {
	reviewed: Set<string>;
	/** "song|playlist" */
	dismissed: Set<string>;
}

export interface Context {
	snapshot: Snapshot;
	ai: AiState;
	decisions: Decisions;
	eligible: Set<string>;
	minPlays: number;
	/** Candidates over the play threshold, best first. */
	candidates: Candidate[];
}

async function context(minPlays: number): Promise<Context> {
	const [snapshot, ai, decisions] = await Promise.all([getSnapshot(), loadAiState(), loadDecisions()]);
	return contextFrom(snapshot, ai, decisions, minPlays);
}

/** A ranking context over any snapshot — the recall test builds its own. */
export function contextFrom(snapshot: Snapshot, ai: AiState, decisions: Decisions, minPlays: number): Context {
	const threshold = Math.max(1, Math.floor(minPlays));
	return {
		snapshot,
		ai,
		decisions,
		eligible: new Set(snapshot.profiles.map((p) => p.id)),
		minPlays: threshold,
		candidates: snapshot.candidates.filter((c) => c.features.plays >= threshold)
	};
}

async function loadDecisions(): Promise<Decisions> {
	const [reviewed, dismissed] = await Promise.all([
		query<{ song_key: string }>(sql`select song_key from sortify_reviewed_songs`),
		query<{ song_key: string; playlist_id: string }>(sql`select song_key, playlist_id from sortify_dismissals`)
	]);
	return {
		reviewed: new Set(reviewed.map((r) => r.song_key)),
		dismissed: new Set(dismissed.map((d) => `${d.song_key}|${d.playlist_id}`))
	};
}

// --------------------------------------------------------------- suggestions

export interface Suggestion {
	playlistId: string;
	objective?: ObjectiveFit;
	ai?: Verdict;
	/** The model looked at this song and did not pick this playlist. */
	rejectedByAI: boolean;
}

export function score(s: Suggestion): number {
	const base = s.objective?.score ?? 0;
	if (s.ai) return base + s.ai.confidence / 3;
	return s.rejectedByAI ? base - 0.3 : base;
}

/** Strong enough to be ticked before the user looks at it. */
export function isStrong(s: Suggestion): boolean {
	if (s.ai) return s.ai.confidence === 3 || (s.ai.confidence === 2 && (s.objective?.score ?? 0) >= 0.2);
	// Without a verdict, only a near-certain data match (many shared artists, same genres).
	return !s.rejectedByAI && (s.objective?.score ?? 0) >= 0.95;
}

function reason(s: Suggestion): string | undefined {
	if (s.ai?.why) return s.ai.why;
	return s.objective?.reasons.length ? s.objective.reasons.join(' · ') : undefined;
}

const fitOf = (c: Candidate, id: string) => c.fits.find((f) => f.playlistId === id);

function holds(ctx: Context, c: Candidate, playlistId: string): boolean {
	const profile = ctx.snapshot.profileById.get(playlistId);
	return profile ? profileContains(profile, c.features) : (ctx.snapshot.ownedMembers.get(playlistId)?.has(c.features.recording) ?? false);
}

const dismissed = (ctx: Context, song: string, playlistId: string) => ctx.decisions.dismissed.has(`${song}|${playlistId}`);

/** The playlists worth showing for a song, best first. */
export function suggestionsFor(ctx: Context, c: Candidate, limit = 5): Suggestion[] {
	const fits = ctx.ai.fits.get(c.song) ?? new Map<string, Verdict>();
	const asked = ctx.ai.asked.has(c.song);
	const ids = new Set([...c.fits.slice(0, 6).map((f) => f.playlistId), ...fits.keys()]);
	return [...ids]
		.filter(
			(id) =>
				ctx.eligible.has(id) && !holds(ctx, c, id) && !c.inPlaylists.includes(id) && !dismissed(ctx, c.song, id)
		)
		.map((id) => ({ playlistId: id, objective: fitOf(c, id), ai: fits.get(id), rejectedByAI: asked && !fits.has(id) }))
		.filter((s) => s.ai !== undefined || score(s) >= 0.3)
		.sort((a, b) => score(b) - score(a))
		.slice(0, limit);
}

function suggestionIn(ctx: Context, c: Candidate, playlistId: string): Suggestion {
	const ai = ctx.ai.fits.get(c.song)?.get(playlistId);
	return {
		playlistId,
		objective: fitOf(c, playlistId),
		ai,
		rejectedByAI: ai === undefined && hasJudged(ctx.ai, c.song, playlistId)
	};
}

// --------------------------------------------------------------- what the app gets

export interface SuggestionJson {
	playlist: string;
	score: number;
	strong: boolean;
	/** The model's rating, 1–3, when it gave one. */
	confidence?: number;
	reason?: string;
}

export interface CandidateJson {
	song: string;
	track: SortifyTrack;
	plays: number;
	year?: number;
	genre?: string;
	/** Eligible playlists already holding the song. */
	in_playlists: string[];
	suggestions: SuggestionJson[];
	/** What to tick before the user touches anything: up to three strong suggestions. */
	selected: string[];
	/** A new playlist the model would start for it, when nothing strong fits. */
	idea?: string;
	/** The model is being asked about this song right now. */
	pending: boolean;
	asked: boolean;
}

function suggestionJson(s: Suggestion): SuggestionJson {
	return {
		playlist: s.playlistId,
		score: Math.round(score(s) * 1000) / 1000,
		strong: isStrong(s),
		confidence: s.ai?.confidence,
		reason: reason(s)
	};
}

async function render(ctx: Context, list: Candidate[], suggestions = (c: Candidate) => suggestionsFor(ctx, c)) {
	const tracks = new Map((await tracksByIds(list.map((c) => c.trackId))).map((t) => [t.id, t]));
	return list
		.filter((c) => tracks.has(c.trackId))
		.map((c): CandidateJson => {
			const s = suggestions(c);
			const strong = s.some(isStrong);
			return {
				song: c.song,
				track: tracks.get(c.trackId)!,
				plays: c.features.plays,
				year: c.features.year ?? undefined,
				genre: topGenres(c.features, 1)[0],
				in_playlists: c.inPlaylists,
				suggestions: s.map(suggestionJson),
				selected: s.filter(isStrong).slice(0, 3).map((x) => x.playlistId),
				idea: strong ? undefined : ctx.ai.ideas.get(c.song),
				pending: isPending(c.song),
				asked: ctx.ai.asked.has(c.song)
			};
		});
}

// --------------------------------------------------------------- the song queue

export interface QueueJson {
	counts: { candidates: number; remaining: number; reviewed: number; left_out: number };
	min_plays: number;
	songs: CandidateJson[];
}

function counts(ctx: Context) {
	const queue = ctx.candidates.filter((c) => !ctx.decisions.reviewed.has(c.song));
	return {
		candidates: ctx.candidates.length,
		remaining: queue.length,
		reviewed: ctx.candidates.length - queue.length,
		left_out: queue.filter((c) => c.inPlaylists.length === 0).length
	};
}

/**
 * The next songs waiting, best first. The app shows the first page and asks
 * the model about the next while the user works through it.
 */
export async function queue(minPlays: number, limit = PAGE_SIZE * 2, exclude: string[] = []): Promise<QueueJson> {
	const ctx = await context(minPlays);
	const skip = new Set(exclude);
	const next = ctx.candidates.filter((c) => !ctx.decisions.reviewed.has(c.song) && !skip.has(c.song)).slice(0, limit);
	return { counts: counts(ctx), min_plays: ctx.minPlays, songs: await render(ctx, next) };
}

/** Asks the model about these songs (the ones it has not seen), then shows them again. */
export async function judge(songs: string[], minPlays: number): Promise<CandidateJson[]> {
	const snapshot = await getSnapshot();
	const list = songs
		.slice(0, PAGE_SIZE * 2)
		.map((s) => snapshot.candidateBySong.get(s))
		.filter((c): c is Candidate => c !== undefined);
	await judgeSongs(list, snapshot);
	const ctx = await context(minPlays);
	return render(ctx, list);
}

export interface ApplyRow {
	song: string;
	/** The playlists ticked for it; empty skips the song. */
	playlists: string[];
}

export interface ApplyResult {
	songs: number;
	adds: number;
	playlists: number;
	membership: Record<string, string[]>;
}

/**
 * Adds every ticked song to its playlists, turns down the suggestions left
 * unticked, and marks the songs reviewed. Turning down is what makes the next
 * page better: that song is never offered to that playlist again.
 */
export async function apply(rows: ApplyRow[], minPlays: number): Promise<ApplyResult> {
	const ctx = await context(minPlays);
	const byPlaylist = new Map<string, string[]>();
	const added = new Map<string, Set<string>>();
	const found: Candidate[] = [];
	for (const row of rows) {
		const c = ctx.snapshot.candidateBySong.get(row.song);
		if (!c) continue;
		found.push(c);
		for (const id of new Set(row.playlists)) {
			if (holds(ctx, c, id)) continue;
			byPlaylist.set(id, [...(byPlaylist.get(id) ?? []), c.trackId]);
			added.set(c.song, new Set([...(added.get(c.song) ?? []), id]));
		}
	}

	const membership: Record<string, string[]> = {};
	for (const [id, trackIds] of byPlaylist) {
		const result = await addTracks(id, trackIds);
		Object.assign(membership, result.membership);
	}

	await db.transaction(async (tx) => {
		for (const c of found) {
			for (const s of suggestionsFor(ctx, c, 8)) {
				if (added.get(c.song)?.has(s.playlistId)) continue;
				await tx.execute(sql`
					insert into sortify_dismissals (song_key, playlist_id) values (${c.song}, ${s.playlistId})
					on conflict do nothing
				`);
			}
			await tx.execute(sql`
				insert into sortify_reviewed_songs (song_key, track_id) values (${c.song}, ${c.trackId})
				on conflict (song_key) do update set track_id = excluded.track_id, reviewed_at = now()
			`);
		}
	});

	const adds = [...added.values()].reduce((n, s) => n + s.size, 0);
	return { songs: added.size, adds, playlists: byPlaylist.size, membership };
}

export async function resetReviewed(): Promise<void> {
	await db.execute(sql`delete from sortify_reviewed_songs`);
}

// --------------------------------------------------------------- filling one playlist

export interface ProfileJson {
	id: string;
	name: string;
	size: number;
	years?: [number, number];
	is_era: boolean;
	top_genres: string[];
	top_artists: string[];
	/** Songs strongly suggested for it. */
	waiting: number;
}

function profileJson(ctx: Context, id: string, waiting: number): ProfileJson | null {
	const p = ctx.snapshot.profileById.get(id);
	if (!p) return null;
	return {
		id: p.id,
		name: p.name,
		size: p.size,
		years: p.years ?? undefined,
		is_era: p.isEra,
		top_genres: p.topGenres.slice(0, 5),
		top_artists: p.topArtists,
		waiting
	};
}

/** How many songs are strongly suggested for each eligible playlist. */
function waitingCounts(ctx: Context): Map<string, number> {
	const out = new Map<string, number>();
	for (const c of ctx.candidates) {
		const fits = ctx.ai.fits.get(c.song) ?? new Map<string, Verdict>();
		const asked = ctx.ai.asked.has(c.song);
		const ids = new Set(c.fits.filter((f) => f.score >= 0.5).map((f) => f.playlistId));
		for (const [id, v] of fits) if (v.confidence >= 2) ids.add(id);
		for (const id of ids) {
			if (dismissed(ctx, c.song, id) || !ctx.eligible.has(id)) continue;
			const s: Suggestion = { playlistId: id, objective: fitOf(c, id), ai: fits.get(id), rejectedByAI: asked && !fits.has(id) };
			if (score(s) >= 0.6) out.set(id, (out.get(id) ?? 0) + 1);
		}
	}
	return out;
}

export async function playlistsTab(minPlays: number): Promise<ProfileJson[]> {
	const ctx = await context(minPlays);
	const waiting = waitingCounts(ctx);
	return ctx.snapshot.profiles
		.map((p) => profileJson(ctx, p.id, waiting.get(p.id) ?? 0)!)
		.sort((a, b) => b.waiting - a.waiting || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

interface FillRow {
	candidate: Candidate;
	suggestion: Suggestion;
}

/**
 * Songs that could go into one playlist, best first — including songs already
 * reviewed in the queue, since a playlist can fill up long after its songs went
 * by.
 */
function fillRows(ctx: Context, playlistId: string, limit = 60): FillRow[] {
	const out: FillRow[] = [];
	for (const c of ctx.candidates) {
		if (c.inPlaylists.includes(playlistId) || dismissed(ctx, c.song, playlistId) || holds(ctx, c, playlistId)) continue;
		const s = suggestionIn(ctx, c, playlistId);
		if (s.ai === undefined && (s.objective?.score ?? 0) < 0.25) continue;
		out.push({ candidate: c, suggestion: s });
	}
	out.sort((a, b) => score(b.suggestion) - score(a.suggestion) || b.candidate.priority - a.candidate.priority);
	return out.slice(0, limit);
}

export interface FillJson {
	playlist: ProfileJson;
	pending: boolean;
	/** The playlist → songs prompt has run for it before. */
	judged: boolean;
	songs: Array<CandidateJson & { suggestion: SuggestionJson; ticked: boolean }>;
}

export async function fill(playlistId: string, minPlays: number): Promise<FillJson | null> {
	const ctx = await context(minPlays);
	const rows = fillRows(ctx, playlistId);
	const profile = profileJson(ctx, playlistId, waitingCounts(ctx).get(playlistId) ?? 0);
	if (!profile) return null;
	const bySong = new Map(rows.map((r) => [r.candidate.song, r.suggestion]));
	const rendered = await render(ctx, rows.map((r) => r.candidate));
	return {
		playlist: profile,
		pending: isPlaylistPending(playlistId),
		judged: (ctx.ai.judged.get(playlistId)?.size ?? 0) > 0,
		songs: rendered.map((c) => {
			const s = bySong.get(c.song)!;
			// Only what the model confirmed is ticked here: a long list of data-only matches is for browsing.
			return { ...c, suggestion: suggestionJson(s), ticked: s.ai !== undefined && isStrong(s) };
		})
	};
}

/** Has the model judge the best candidates for one playlist it has not judged yet. */
export async function judgePlaylistCandidates(playlistId: string, minPlays: number): Promise<FillJson | null> {
	const ctx = await context(minPlays);
	if (!ctx.snapshot.profileById.has(playlistId)) return null;
	let batch = fillRows(ctx, playlistId, 200)
		.map((r) => r.candidate)
		.filter((c) => !hasJudged(ctx.ai, c.song, playlistId));
	if (batch.length < 15) {
		// A new or tiny playlist has no profile to match on yet; let the model pick from the queue.
		const have = new Set(batch.map((c) => c.song));
		const extra = ctx.candidates.filter(
			(c) =>
				!have.has(c.song) &&
				!c.inPlaylists.includes(playlistId) &&
				!holds(ctx, c, playlistId) &&
				!hasJudged(ctx.ai, c.song, playlistId)
		);
		batch = [...batch, ...extra.slice(0, 30 - batch.length)];
	}
	await judgeForPlaylist(playlistId, batch, ctx.snapshot);
	return fill(playlistId, minPlays);
}

export async function dismiss(song: string, playlistId: string): Promise<void> {
	await db.execute(sql`
		insert into sortify_dismissals (song_key, playlist_id) values (${song}, ${playlistId})
		on conflict do nothing
	`);
}

// --------------------------------------------------------------- new playlists

export interface IdeaJson {
	id: string;
	name: string;
	description: string;
	songs: CandidateJson[];
}

/** Songs in no playlist with nothing strong to go to: the material for new playlists. */
function leftovers(ctx: Context): Candidate[] {
	return ctx.candidates.filter((c) => {
		if (ctx.decisions.reviewed.has(c.song) || c.inPlaylists.length > 0) return false;
		const best = suggestionsFor(ctx, c, 1)[0];
		return (best ? score(best) : 0) < 0.6;
	});
}

export async function ideas(minPlays: number): Promise<{ leftovers: number; ideas: IdeaJson[] }> {
	const ctx = await context(minPlays);
	const rows = await query<{ id: string; name: string; description: string; song_keys: string[] }>(sql`
		select id, name, description, song_keys from sortify_ideas order by created_at desc, name
	`);
	const out: IdeaJson[] = [];
	for (const r of rows) {
		const list = r.song_keys.map((k) => ctx.snapshot.candidateBySong.get(k)).filter((c): c is Candidate => !!c);
		out.push({ id: r.id, name: r.name, description: r.description, songs: await render(ctx, list, () => []) });
	}
	return { leftovers: leftovers(ctx).length, ideas: out };
}

export class NotEnoughSongs extends Error {
	constructor() {
		super('Not enough unsorted songs left to group.');
		this.name = 'NotEnoughSongs';
	}
}

/** One larger request grouping the most played leftovers into proposed playlists. */
export async function propose(minPlays: number): Promise<{ added: number }> {
	const ctx = await context(minPlays);
	const batch = leftovers(ctx).slice(0, 150);
	if (batch.length < 6) throw new NotEnoughSongs();
	const [{ ideasModel }, existing, current] = await Promise.all([
		models(),
		listPlaylists(),
		query<{ name: string }>(sql`select name from sortify_ideas`)
	]);
	const taken = new Set([...existing.filter((p) => p.owned).map((p) => p.name), ...current.map((c) => c.name)].map((n) => n.toLowerCase()));
	const proposed = await proposePlaylists(batch, ctx.snapshot.profiles, taken, ideasModel);
	// Newest first on the page, best first within a batch: insert the best last.
	for (const p of [...proposed].reverse()) {
		await db.execute(sql`
			insert into sortify_ideas (name, description, song_keys, model)
			values (${p.name}, ${p.description}, ${textArray(p.songKeys)}, ${ideasModel})
		`);
	}
	return { added: proposed.length };
}

export async function deleteIdea(id: string): Promise<boolean> {
	const rows = await query<{ id: string }>(sql`delete from sortify_ideas where id::text = ${id} returning id`);
	return rows.length > 0;
}
