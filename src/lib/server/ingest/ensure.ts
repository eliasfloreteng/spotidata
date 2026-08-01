import { sql } from 'drizzle-orm';
import pg from 'pg';
import { db } from '../db/index.ts';
import { config } from '../config.ts';
import { getWorkerUtils } from '../queue/runner.ts';
import { PRIORITY_ONDEMAND, SPOTIFY_FLAG } from '../queue/constants.ts';
import type { EntityKind } from '../queue/tasks/ondemand.ts';

/** Refetch an entity if the stored copy is older than this. */
const STALE_AFTER = "interval '30 days'";

const FRESHNESS: Record<EntityKind, string> = {
	track: `select 1 from spotify_tracks
	         where id = $1 and detail_level = 'full'
	           and fetched_at > now() - ${STALE_AFTER}`,
	album: `select 1 from albums
	         where id = $1 and detail_level = 'full'
	           and fetched_at > now() - ${STALE_AFTER}`,
	artist: `select 1 from artists
	         where id = $1 and detail_level = 'full'
	           and fetched_at > now() - ${STALE_AFTER}`,
	playlist: `select 1 from playlists
	            where id = $1 and items_synced_at is not null
	              and items_synced_at > now() - ${STALE_AFTER}`
};

export interface EnsureResult {
	/** True when the entity is present and fresh enough to render fully. */
	ready: boolean;
	/** True when Spotify says it does not exist. */
	missing: boolean;
	/** True when a fetch is queued and the caller should render a skeleton. */
	pending: boolean;
}

/**
 * Guarantees an entity is in the database, fetching it on demand.
 *
 * The page never calls Spotify itself. Going through the queue keeps one
 * rate-limit authority (an inline fetch would race the token bucket, and a 429
 * triggered by idle browsing would poison a running sync), and the on-demand
 * job's negative priority puts it ahead of thousands of queued sync jobs.
 *
 * LISTEN is established BEFORE the job is enqueued — the reverse order loses
 * the notification when the worker is fast, which is the common case.
 */
export async function ensureEntity(
	kind: EntityKind,
	id: string,
	waitMs = 6000
): Promise<EnsureResult> {
	const { rows } = await db.execute(sql.raw(FRESHNESS[kind].replace('$1', `'${sanitize(id)}'`)));
	if (rows.length > 0) return { ready: true, missing: false, pending: false };

	const listener = new pg.Client({ connectionString: config.databaseUrl });
	let settled: 'ready' | 'missing' | null = null;

	try {
		await listener.connect();
		const waiter = new Promise<void>((resolve) => {
			listener.on('notification', (msg) => {
				if (!msg.payload) return;
				try {
					const p = JSON.parse(msg.payload) as { kind: string; id: string; status: string };
					if (p.kind === kind && p.id === id) {
						settled = p.status === 'missing' ? 'missing' : 'ready';
						resolve();
					}
				} catch {
					/* ignore malformed payloads */
				}
			});
		});
		await listener.query('LISTEN spotidata_ingest');

		const utils = await getWorkerUtils();
		await utils.addJob(
			'ondemand:entity',
			{ kind, id, depth: 1 },
			{
				jobKey: `ondemand:${kind}:${id}`,
				jobKeyMode: 'preserve_run_at',
				priority: PRIORITY_ONDEMAND,
				flags: [SPOTIFY_FLAG],
				maxAttempts: 3
			}
		);

		await Promise.race([waiter, new Promise((r) => setTimeout(r, waitMs))]);
	} catch {
		// A listener failure must not break the page; fall through to pending.
	} finally {
		await listener.end().catch(() => {});
	}

	if (settled === 'ready') return { ready: true, missing: false, pending: false };
	if (settled === 'missing') return { ready: false, missing: true, pending: false };
	return { ready: false, missing: false, pending: true };
}

/** Spotify ids are base62; anything else cannot match a row anyway. */
function sanitize(id: string): string {
	return id.replace(/[^A-Za-z0-9]/g, '');
}
