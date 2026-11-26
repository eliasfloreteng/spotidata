import { sql } from 'drizzle-orm';
import { query } from '../db/index.ts';
import { iso } from '../entities/shared.ts';
import { ANALYSE_JOB_KEY } from '../queue/constants.ts';
import { loadSettings } from '../settings.ts';
import { DEEZER_SERVICE } from './deezer.ts';

/**
 * How far rbxport's analysis of the library has got, for `/sync`.
 *
 * Nothing here is bookkeeping the chain writes: the counts are
 * `track_analysis` against `spotidata.analyse_candidates`, the requests and any
 * block are the Deezer limiter's, and whether the chain is alive (and what its
 * last attempt threw) is its own job on the queue. So the page cannot disagree
 * with what was actually measured.
 */

export type AnalysisState = 'off' | 'blocked' | 'complete' | 'failing' | 'running' | 'waiting';

export interface AnalysisStatus {
	state: AnalysisState;
	/** Library recordings with an ISRC — what there is to measure. */
	candidates: number;
	measured: number;
	/** Deezer has no preview of these. */
	missing: number;
	/** A preview rbxport could not measure. */
	failed: number;
	lastAnalysedAt: string | null;
	requests: number;
	blockedUntil: string | null;
	/** The error the queued job's last attempt threw, while it is being retried. */
	lastError: string | null;
}

export async function getAnalysisStatus(): Promise<AnalysisStatus> {
	const [[counts], [limiter], [job], settings] = await Promise.all([
		query<{
			candidates: number;
			measured: number;
			missing: number;
			failed: number;
			lastAnalysedAt: string | null;
		}>(sql`
			select count(*)::int                                     as candidates,
			       count(*) filter (where ta.status = 'ok')::int      as measured,
			       count(*) filter (where ta.status = 'missing')::int as missing,
			       count(*) filter (where ta.status = 'failed')::int  as failed,
			       ${iso('max(ta.analysed_at)')}                      as "lastAnalysedAt"
			  from spotidata.analyse_candidates c
			  left join track_analysis ta on ta.isrc = c.isrc
		`),
		query<{ requests: number; blockedUntil: string | null }>(sql`
			select requests_total as requests,
			       case when blocked_until > now() then ${iso('blocked_until')} end as "blockedUntil"
			  from external_limiters
			 where service = ${DEEZER_SERVICE}
		`),
		query<{ lastError: string | null }>(sql`
			select last_error as "lastError"
			  from graphile_worker._private_jobs
			 where key = ${ANALYSE_JOB_KEY}
		`),
		loadSettings()
	]);

	const c = counts ?? { candidates: 0, measured: 0, missing: 0, failed: 0, lastAnalysedAt: null };
	const left = c.candidates - c.measured - c.missing - c.failed;
	const blockedUntil = limiter?.blockedUntil ?? null;

	const state: AnalysisState = !settings['analysis.enabled']
		? 'off'
		: blockedUntil
			? 'blocked'
			: left <= 0
				? 'complete'
				: job?.lastError
					? 'failing'
					: job
						? 'running'
						: // Work is left and nothing is queued: the cron restarts the chain
							// within fifteen minutes.
							'waiting';

	return {
		state,
		...c,
		requests: limiter?.requests ?? 0,
		blockedUntil,
		lastError: job?.lastError ?? null
	};
}

/**
 * Forgets every recording that was not measured, so the next pass asks again:
 * Deezer adds catalog daily, and a failed measurement may be a bad download.
 */
export async function clearAnalysisMisses(): Promise<void> {
	await query(sql`delete from track_analysis where status <> 'ok'`);
}
