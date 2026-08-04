import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, query } from '../db/index.ts';
import { config } from '../config.ts';
import { getWorkerUtils } from '../queue/runner.ts';

/** Creating and tracking import jobs — the half of the importer the UI talks to. */

export interface ImportSummary {
	id: number;
	label: string;
	kind: 'zip' | 'folder';
	status: string;
	sizeBytes: number | null;
	files: number;
	filesDone: number;
	rowsRead: number;
	playsInserted: number;
	duplicates: number;
	firstPlayedAt: string | null;
	lastPlayedAt: string | null;
	error: string | null;
	createdAt: string;
	finishedAt: string | null;
	/** Plays still attributed to this import; a re-import of the same archive adds none. */
	livePlays: number;
}

export async function listImports(limit = 20): Promise<ImportSummary[]> {
	return query<ImportSummary>(sql`
		select i.id, i.label, i.kind, i.status,
		       i.size_bytes      as "sizeBytes",
		       i.files, i.files_done as "filesDone",
		       i.rows_read       as "rowsRead",
		       i.plays_inserted  as "playsInserted",
		       i.duplicates,
		       to_char(i.first_played_at at time zone 'UTC', 'YYYY-MM-DD') as "firstPlayedAt",
		       to_char(i.last_played_at  at time zone 'UTC', 'YYYY-MM-DD') as "lastPlayedAt",
		       i.error,
		       to_char(i.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "createdAt",
		       to_char(i.finished_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "finishedAt",
		       (select count(*)::int from plays p where p.import_id = i.id) as "livePlays"
		  from play_imports i
		 order by i.created_at desc
		 limit ${limit}
	`);
}

/**
 * Registers an archive and queues it.
 *
 * The job carries only the row id: the archive's own path lives in the table,
 * so a restarted worker picks up exactly what a crashed one was doing, and the
 * progress the page polls is the same row the job writes.
 */
export async function queueImport(opts: {
	label: string;
	path: string;
	kind: 'zip' | 'folder';
	sizeBytes?: number | null;
	temporary?: boolean;
}): Promise<number> {
	const rows = await query<{ id: number }>(sql`
		insert into play_imports (label, path, kind, size_bytes, temporary)
		values (${opts.label}, ${opts.path}, ${opts.kind}, ${opts.sizeBytes ?? null},
		        ${opts.temporary ?? false})
		returning id
	`);
	const id = rows[0]!.id;

	const utils = await getWorkerUtils();
	await utils.addJob('history:import', { importId: id }, {
		jobKey: `history:import:${id}`,
		// One archive at a time whatever the worker's concurrency: two imports
		// racing on the same unique key would spend their time deadlocking, and
		// there is never a reason to run more than one.
		queueName: 'history-import',
		maxAttempts: 1
	});
	return id;
}

/** Somewhere to stream an upload to, created on demand. */
export async function reserveUploadPath(filename: string): Promise<string> {
	await fs.mkdir(config.history.uploadDir, { recursive: true });
	// The user's filename never reaches the filesystem — only its extension,
	// which is all the importer reads it for.
	const ext = path.extname(filename).toLowerCase() === '.zip' ? '.zip' : '.bin';
	return path.join(config.history.uploadDir, `${Date.now()}-${randomBytes(6).toString('hex')}${ext}`);
}

/**
 * Removes an import and everything it contributed.
 *
 * Plays are deleted by `import_id` rather than by time span: a play the export
 * shared with the API poll was collapsed into a single row on the way in, and
 * deleting by span would take the poll's evidence with it.
 */
export async function undoImport(id: number): Promise<number> {
	const result = await db.execute(sql`delete from plays where import_id = ${id}`);
	await db.execute(sql`delete from play_imports where id = ${id}`);
	return (result as { rowCount?: number | null }).rowCount ?? 0;
}
