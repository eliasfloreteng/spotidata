import { sql } from 'drizzle-orm';
import { query } from '../db/index.ts';
import { getMe } from '../ingest/upsert-users.ts';
import { activeRun } from '../queue/phases.ts';
import { getWorkerUtils } from '../queue/runner.ts';
import { PLAYLIST_WRITE_SCOPES, readAuthState } from '../spotify/auth.ts';
import { cardCacheSize, models, spend } from './ai.ts';
import { isAvailable } from './openrouter.ts';
import { missingPlaybackScopes } from './player.ts';

/**
 * What the app needs to know before anything else: whose account this is,
 * whether the grant can do what Sortify asks of it, how fresh the mirror is,
 * and how the model is set up.
 */
export async function sortifyStatus(origin: string) {
	const [auth, me, synced, run, ai, spent, cards, liked] = await Promise.all([
		readAuthState(),
		getMe(),
		query<{ at: string | null }>(sql`
			select to_char(max(finished_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as at
			  from sync_runs where status = 'completed'
		`),
		activeRun(),
		models(),
		spend(),
		cardCacheSize(),
		query<{ n: number }>(sql`select count(*)::int as n from saved_tracks where removed_at is null`)
	]);
	const held = new Set((auth?.scope ?? '').split(/\s+/).filter(Boolean));
	const playlistMissing = PLAYLIST_WRITE_SCOPES.filter((s) => !held.has(s));
	const playbackMissing = missingPlaybackScopes(auth?.scope);
	return {
		account: me ? { id: me.id, name: me.displayName ?? me.id } : null,
		signed_in: auth !== null && !auth.needsReauth,
		reauthorize_url: `${origin}/auth/login`,
		scopes: {
			playlists: { ok: playlistMissing.length === 0, missing: playlistMissing },
			playback: { ok: playbackMissing.length === 0, missing: playbackMissing }
		},
		sync: { last_completed_at: synced[0]?.at ?? null, running: run !== null },
		liked_songs: liked[0]?.n ?? 0,
		ai: {
			available: isAvailable(),
			card_model: ai.cardModel,
			sort_model: ai.sortModel,
			ideas_model: ai.ideasModel,
			spent_usd: spent.usd,
			requests: spent.requests,
			cached_cards: cards
		}
	};
}

/** Below this, a sync that just ran is fresh enough and asking again is a no-op. */
const FRESH_MS = 30 * 60_000;

/**
 * Asks for an incremental sync, so liked songs saved in Spotify since the last
 * one reach the feed. Cheap — a resync with nothing new is about seventeen
 * requests — but still not repeated within half an hour of the last.
 */
export async function requestSync(): Promise<{ queued: boolean; running: boolean }> {
	if (await activeRun()) return { queued: false, running: true };
	const rows = await query<{ recent: boolean }>(sql`
		select coalesce(max(finished_at) > now() - make_interval(secs => ${FRESH_MS / 1000}), false) as recent -- sql-lint: internal
		  from sync_runs where status = 'completed'
	`);
	if (rows[0]?.recent) return { queued: false, running: false };
	const utils = await getWorkerUtils();
	await utils.addJob('sync:start', { mode: 'incremental', trigger: 'sortify' }, { jobKey: 'sync:start:manual' });
	return { queued: true, running: false };
}
