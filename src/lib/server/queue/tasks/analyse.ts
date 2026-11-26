import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Task } from 'graphile-worker';
import { sql } from 'drizzle-orm';
import { db, query } from '../../db/index.ts';
import { trackAnalysis } from '../../db/schema/index.ts';
import { loadSettings } from '../../settings.ts';
import { downloadPreview, findPreview, type Preview, type Wanted } from '../../analysis/deezer.ts';
import { ServiceBlocked } from '../../analysis/limiter.ts';
import { analyse, analyserVersion } from '../../analysis/rbxport.ts';
import { ANALYSE_JOB_KEY, PRIORITY_ANALYSE } from '../constants.ts';

/**
 * rbxport's tempo and key for every recording in the library, measured from
 * Deezer's 30-second previews, as one self-chaining job.
 *
 * One job does a bounded batch and re-enqueues itself while there is work; a
 * cron entry restarts the chain when a sync brings new music. It keeps no
 * bookkeeping of its own: `/sync` reads its progress off `track_analysis`, the
 * Deezer limiter and the queued job (`analysis/status.ts`).
 *
 * Against rekordbox's analysis of the full files, a preview's tempo agrees to
 * within 1 BPM for 86% of tracks (94% counting a doubled or halved tempo,
 * which the DJ tab folds) and its key exactly for 73%, a neighbour on the
 * wheel for 90%.
 */

/** A tick is a minute or less: four lookups a second, then the analysis. */
const BATCH = 40;

/** Only one chain may run at a time; see `withLock`. */
const LOCK_KEY = 0x5e17c5;

interface Candidate extends Wanted {
	plays: number;
}

type Row = typeof trackAnalysis.$inferInsert;

async function save(rows: Row[]): Promise<void> {
	if (rows.length === 0) return;
	await db
		.insert(trackAnalysis)
		.values(rows)
		.onConflictDoUpdate({
			target: trackAnalysis.isrc,
			set: {
				status: sql`excluded.status`,
				deezerTrackId: sql`excluded.deezer_track_id`,
				matchedBy: sql`excluded.matched_by`,
				bpm: sql`excluded.bpm`,
				bpmConfidence: sql`excluded.bpm_confidence`,
				keyName: sql`excluded.key_name`,
				camelot: sql`excluded.camelot`,
				seconds: sql`excluded.seconds`,
				rms: sql`excluded.rms`,
				analyser: sql`excluded.analyser`,
				error: sql`excluded.error`,
				analysedAt: sql`now()`
			}
		});
}

/**
 * One batch: find each preview, download it, then measure them all in one
 * run of the analyser. A rate-limit block part way through still saves what
 * was measured before it, then hands the block to the chain.
 *
 * Returns how many recordings it looked at; zero means the library is done.
 */
async function analyseBatch(): Promise<number> {
	const pending = await query<Candidate>(sql`
		select c.isrc, c.title, c.artist, c.duration_ms as "durationMs", c.plays
		  from spotidata.analyse_candidates c
		  left join track_analysis ta on ta.isrc = c.isrc
		 where ta.isrc is null
		 order by c.plays desc, c.isrc
		 limit ${BATCH}
	`);
	if (pending.length === 0) return 0;

	const analyser = await analyserVersion();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'spotidata-rbx-'));
	const rows: Row[] = [];
	const downloaded = new Map<string, { c: Candidate; preview: Preview }>();
	let blocked: ServiceBlocked | null = null;

	try {
		for (const c of pending) {
			let preview: Preview | null;
			try {
				preview = await findPreview(c);
			} catch (err) {
				if (err instanceof ServiceBlocked) {
					blocked = err;
					break;
				}
				throw err;
			}
			if (!preview) {
				rows.push({ isrc: c.isrc, status: 'missing', analyser });
				continue;
			}
			const file = path.join(dir, `${c.isrc}.mp3`);
			try {
				await fs.writeFile(file, await downloadPreview(preview.url));
				downloaded.set(file, { c, preview });
			} catch (err) {
				// The CDN failing one file is that file's problem, and the next
				// pass asks again: nothing is recorded for it.
				console.warn(`[analyse] ${c.isrc}: ${String(err)}`);
			}
		}

		const measured = await analyse([...downloaded.keys()]);
		for (const [file, { c, preview }] of downloaded) {
			const m = measured.get(file);
			const base = {
				isrc: c.isrc,
				deezerTrackId: preview.deezerTrackId,
				matchedBy: preview.matchedBy,
				analyser
			};
			if (!m || 'error' in m) {
				rows.push({ ...base, status: 'failed', error: m ? m.error : 'no result' });
				continue;
			}
			rows.push({
				...base,
				status: 'ok',
				bpm: m.bpm,
				bpmConfidence: m.bpmConfidence,
				keyName: m.key?.name ?? null,
				camelot: m.key?.camelot ?? null,
				seconds: m.seconds,
				rms: m.rms
			});
		}
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}

	await save(rows);
	if (blocked) throw blocked;
	return pending.length;
}

/**
 * The cron kickstarter and a chained job can otherwise overlap and spend the
 * same second's requests twice. A session advisory lock on a dedicated
 * connection dies with the connection, so a crashed worker cannot wedge it.
 */
async function withLock<T>(fn: () => Promise<T>): Promise<T | null> {
	const client = await db.$client.connect();
	try {
		const { rows } = await client.query<{ locked: boolean }>(
			`SELECT pg_try_advisory_lock(${LOCK_KEY}) AS locked`
		);
		if (!rows[0]?.locked) return null;
		try {
			return await fn();
		} finally {
			await client.query(`SELECT pg_advisory_unlock(${LOCK_KEY})`);
		}
	} finally {
		client.release();
	}
}

export const analyseTick: Task = async (_payload, helpers) => {
	const settings = await loadSettings();
	if (!settings['analysis.enabled']) return;

	// A rate-limit block reschedules the chain for when it lifts. Anything else
	// is thrown: Graphile Worker retries it with backoff and keeps the error on
	// the job, which is where `/sync` reads it from.
	const outcome = await withLock(async (): Promise<{ next: Date | null } | 'done'> => {
		try {
			return (await analyseBatch()) === 0 ? 'done' : { next: null };
		} catch (err) {
			if (err instanceof ServiceBlocked) return { next: err.until };
			throw err;
		}
	});

	// Another chain holds the lock, or the library is measured; the cron entry
	// restarts it when new music arrives.
	if (outcome === null || outcome === 'done') return;

	await helpers.addJob(
		'analyse:tick',
		{},
		{
			jobKey: ANALYSE_JOB_KEY,
			jobKeyMode: 'replace',
			runAt: outcome.next ?? undefined,
			priority: PRIORITY_ANALYSE,
			maxAttempts: 5
		}
	);
};
