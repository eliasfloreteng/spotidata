import { sql } from 'drizzle-orm';
import { query } from '../db/index.ts';

/**
 * Tables that move often and say nothing about what the stats show: the rate
 * limiter and its call counts move on every Spotify request, the sync tables
 * on every step of a run, Sortify's on every card, and the song radios
 * through a backfill that asks Spotify for one every few seconds. Leaving them
 * in would make the version move far more often than the data does.
 */
const UNREAD = [
	'api_call_stats',
	'rate_limiter',
	'auth_states',
	'auth_tokens',
	'ingest_raw',
	'settings',
	'sync_runs',
	'sync_phases',
	'sync_events',
	'song_radios',
	'song_radio_tracks'
];

/**
 * A key that moves whenever data the pages show is written, however it is
 * written: a sync, the history poll, an import, an automation or the engine
 * keeping a playlist all land somewhere here, and no write path has to
 * remember to announce itself.
 *
 * It is Postgres's own count of rows inserted, updated and deleted across the
 * data tables. Every table counts unless it is named as unread, so a table
 * added later is covered by default: forgetting one costs a recompute, never
 * a stale page. The counters reach the statistics a moment after the commit
 * (at most ~10s, when the writing connection goes idle), never before it, so a
 * page computed against data that has since changed is always recomputed
 * once the count catches up.
 */
export async function dataVersion(): Promise<string> {
	const rows = await query<{ v: string }>(sql`
		select coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0)::text as v
		  from pg_stat_user_tables
		 where schemaname = 'public'
		   and relname <> all (${`{${UNREAD.join(',')}}`}::text[])
		   and relname not like 'sortify\_%'
	`);
	return rows[0]?.v ?? '0';
}
