import type { Task } from 'graphile-worker';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { loadSettings } from '../../settings.ts';
import { setTargetRpm, recover, flushCallStats } from '../../spotify/ratelimit.ts';
import { readAuthState } from '../../spotify/auth.ts';
import { probeApi } from '../../spotify/probe.ts';
import { getAccessToken } from '../../spotify/auth.ts';
import {
	PHASES,
	beginRun,
	finishRun,
	logEvent,
	startPhase,
	completePhase,
	type PhaseKey
} from '../phases.ts';

/**
 * Which phase kicks off which. Graphile Worker has no join primitive, so the
 * chain is driven by `phase:complete`, which fires exactly once per phase via
 * the counter check in runLeafTask.
 */
const NEXT: Partial<Record<PhaseKey, string>> = {
	// `liked` and `playlists` both run after `profile`; albums must wait for
	// BOTH, so its trigger is guarded by allPhasesDone() below.
	playlist_items: 'sync:seed-albums',
	liked: 'sync:seed-albums',
	albums: 'sync:seed-album-tracks',
	album_tracks: 'sync:seed-artists',
	artists: 'sync:canonicalize',
	canonicalize: 'sync:derive',
	derive: 'sync:seed-hydrate',
	hydrate: 'sync:canonicalize-final'
};

export const syncStart: Task = async (payload, helpers) => {
	const { mode = 'full', trigger = 'manual' } = (payload ?? {}) as {
		mode?: 'full' | 'incremental';
		trigger?: string;
	};

	const auth = await readAuthState();
	if (!auth || auth.needsReauth) {
		await logEvent(null, 'error', 'Sync aborted: not authorized');
		return;
	}

	const runId = await beginRun(mode, trigger);
	if (runId === null) {
		helpers.logger.info('sync already running; ignoring');
		return;
	}

	const settings = await loadSettings();
	// The very first crawl runs deliberately slow: we do not know this app's
	// real ceiling yet, and an hours-long ban on day one is far more expensive
	// than a slower first sync. Steady state comes from settings.
	const { rows } = await db.execute<{ n: number }>(sql`select count(*)::int as n from spotify_tracks`);
	const isFirstEver = (rows[0]?.n ?? 0) === 0;
	await setTargetRpm(isFirstEver ? 60 : settings['ratelimit.targetRpm'], true);

	// Pre-flight contract test: a removed endpoint should surface as a named
	// failure here rather than as a mystery 404 storm mid-crawl.
	try {
		const results = await probeApi(await getAccessToken());
		const diverged = results.filter((r) => !r.ok);
		if (diverged.length > 0) {
			await logEvent(runId, 'warn', `API contract changed: ${diverged.length} probe(s) diverged`, diverged);
		}
	} catch (err) {
		await logEvent(runId, 'warn', 'API probe failed', { error: String(err) });
	}

	await logEvent(runId, 'info', `Sync started (${mode}, ${trigger})`, {
		targetRpm: isFirstEver ? 60 : settings['ratelimit.targetRpm']
	});

	await helpers.addJob('sync:profile', { runId, mode }, { jobKey: `sync:${runId}:profile` });
};

/** Fires once per phase; advances the chain. */
export const phaseComplete: Task = async (payload, helpers) => {
	const { runId, phaseKey } = payload as { runId: number; phaseKey: PhaseKey };
	await completePhase(runId, phaseKey);
	await flushCallStats();

	const next = NEXT[phaseKey];
	if (!next) return;

	// Albums depend on liked AND playlist_items; only proceed once both are
	// settled, otherwise we would seed album fetching from a half-built library.
	if (next === 'sync:seed-albums') {
		const { rows } = await db.execute<{ pending: number }>(sql`
			select count(*)::int as pending from sync_phases
			 where run_id = ${runId}
			   and key in ('liked','playlist_items')
			   and status not in ('completed','skipped','failed')
		`);
		if ((rows[0]?.pending ?? 0) > 0) return;

		// Album discovery reads library_tracks, so derive it first.
		await db.execute(sql`select spotidata.refresh_library()`);
	}

	await helpers.addJob(next, { runId }, { jobKey: `sync:${runId}:${next}`, jobKeyMode: 'unsafe_dedupe' });
};

// ------------------------------------------------------- derived SQL phases

export const canonicalize: Task = async (payload, helpers) => {
	const { runId } = payload as { runId: number };
	await startPhase(runId, 'canonicalize', 1);

	const { rows } = await db.execute<{ groups: number; tracks: number }>(
		sql`select * from spotidata.refresh_canonical_tracks()`
	);
	await logEvent(
		runId,
		'info',
		`Canonicalized ${rows[0]?.tracks ?? 0} tracks into ${rows[0]?.groups ?? 0} recordings`,
		null,
		'canonicalize'
	);

	await db.execute(sql`update sync_phases set done = 1 where run_id = ${runId} and key = 'canonicalize'`);
	await helpers.addJob('phase:complete', { runId, phaseKey: 'canonicalize' }, {
		jobKey: `sync:${runId}:done:canonicalize`,
		jobKeyMode: 'unsafe_dedupe'
	});
};

export const derive: Task = async (payload, helpers) => {
	const { runId } = payload as { runId: number };
	await startPhase(runId, 'derive', 1);

	const { rows } = await db.execute<{ tracks: number; canonical: number }>(
		sql`select * from spotidata.refresh_library()`
	);
	await db.execute(sql`select spotidata.refresh_album_completeness()`);
	// Keep the planner honest after a bulk load; every chart depends on it.
	await db.execute(sql`analyze`);

	await logEvent(
		runId,
		'info',
		`Library: ${rows[0]?.tracks ?? 0} tracks → ${rows[0]?.canonical ?? 0} recordings`,
		null,
		'derive'
	);

	await db.execute(sql`update sync_phases set done = 1 where run_id = ${runId} and key = 'derive'`);
	await helpers.addJob('phase:complete', { runId, phaseKey: 'derive' }, {
		jobKey: `sync:${runId}:done:derive`,
		jobKeyMode: 'unsafe_dedupe'
	});
};

/** After hydration filled in ISRCs, regroup and rebuild, then finish. */
export const canonicalizeFinal: Task = async (payload, helpers) => {
	const { runId } = payload as { runId: number };
	await db.execute(sql`select spotidata.refresh_canonical_tracks()`);
	await db.execute(sql`select spotidata.refresh_library()`);
	await db.execute(sql`select spotidata.refresh_album_completeness()`);
	await db.execute(sql`analyze`);
	await helpers.addJob('sync:finalize', { runId }, { jobKey: `sync:${runId}:finalize` });
};

export const finalize: Task = async (payload) => {
	const { runId } = payload as { runId: number };
	await startPhase(runId, 'finalize', 1);
	await flushCallStats();

	const { rows } = await db.execute<Record<string, number>>(sql`
		select (select count(*)::int from spotify_tracks)     as tracks,
		       (select count(*)::int from canonical_tracks)   as recordings,
		       (select count(*)::int from library_tracks)     as library_tracks,
		       (select count(*)::int from library_canonical)  as library_recordings,
		       (select count(*)::int from albums)             as albums,
		       (select count(*)::int from artists)            as artists,
		       (select count(*)::int from playlists where removed_at is null) as playlists,
		       (select count(*)::int from saved_tracks where removed_at is null) as liked
	`);
	const stats = rows[0] ?? {};

	const { rows: reqRows } = await db.execute<{ requests: number }>(sql`
		select coalesce(sum(requests), 0)::int as requests from api_call_stats
		 where bucket >= (select started_at from sync_runs where id = ${runId})
	`);

	await db.execute(sql`
		update sync_runs
		   set stats = ${JSON.stringify(stats)}::jsonb,
		       api_requests = ${reqRows[0]?.requests ?? 0}
		 where id = ${runId}
	`);
	await db.execute(sql`update sync_phases set done = 1, status = 'completed', finished_at = now()
	                      where run_id = ${runId} and key = 'finalize'`);

	// Keep the event log from growing without bound.
	await db.execute(sql`
		delete from sync_events
		 where run_id = ${runId} and level = 'debug'
	`);

	await finishRun(runId, 'completed');
	await logEvent(runId, 'info', 'Sync complete', stats);
};

// ------------------------------------------------------------- maintenance

/**
 * Watchdog for a run that stopped advancing.
 *
 * The phase chain is event-driven, so any missed `phase:complete` strands the
 * run at 'running' with an empty queue — invisible except as a sync that never
 * ends. This closes out a run whose phases are all settled, and fails one that
 * has had no queued work and no progress for an hour.
 */
export const watchdog: Task = async (_payload, helpers) => {
	const { rows } = await db.execute<{ id: number; unsettled: number; queued: number; idle_s: number }>(sql`
		select r.id,
		       count(*) filter (where p.status not in ('completed','skipped','failed'))::int as unsettled,
		       (select count(*)::int from graphile_worker._private_jobs j
		         where j.key like 'sync:' || r.id || ':%')                                   as queued,
		       extract(epoch from now() - greatest(
		         r.started_at, coalesce(max(p.finished_at), r.started_at)))::int              as idle_s
		  from sync_runs r
		  join sync_phases p on p.run_id = r.id
		 where r.status = 'running'
		 group by r.id
	`);

	for (const run of rows) {
		if (run.unsettled === 0) {
			await helpers.addJob('sync:finalize', { runId: run.id }, {
				jobKey: `sync:${run.id}:finalize`,
				jobKeyMode: 'unsafe_dedupe'
			});
			await logEvent(run.id, 'warn', 'Watchdog: all phases settled but run was still open');
		} else if (run.queued === 0 && run.idle_s > 3600) {
			await finishRun(run.id, 'failed', `stalled with ${run.unsettled} unfinished phase(s)`);
			await logEvent(run.id, 'error', `Watchdog: stalled for ${Math.round(run.idle_s / 60)} min with an empty queue`);
		}
	}
};

export const rateRecover: Task = async () => {
	await recover();
	await flushCallStats();
};

export const pruneEvents: Task = async () => {
	await db.execute(sql`delete from sync_events where at < now() - interval '30 days'`);
	await db.execute(sql`delete from api_call_stats where bucket < now() - interval '90 days'`);
	await db.execute(sql`
		delete from sync_runs
		 where status in ('completed','failed','cancelled')
		   and created_at < now() - interval '90 days'
	`);
};

/** Marks a stuck run failed so the partial unique index frees up. */
export const cancelRun: Task = async (payload) => {
	const { runId, reason } = payload as { runId: number; reason?: string };
	await finishRun(runId, 'cancelled', reason);
	await logEvent(runId, 'warn', `Sync cancelled: ${reason ?? 'by user'}`);
};

export const PHASE_KEYS = PHASES.map((p) => p.key);
