import fs from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { db, query } from '../db/index.ts';
import { logEvent } from '../queue/phases.ts';
import {
	dropSupersededPolls,
	insertPlays,
	linkPlays,
	refreshPlayStats
} from '../ingest/upsert-plays.ts';
import { openHistorySource, parseHistoryFile } from './streaming-history.ts';

export interface ImportRow {
	id: number;
	label: string;
	path: string;
	kind: 'zip' | 'folder';
	temporary: boolean;
	status: string;
}

/**
 * Runs one archive to completion.
 *
 * Files are read and written one at a time rather than gathered first: a
 * year of history is ~12 MB of JSON and ~50 MB once parsed, and the export
 * runs to twenty of them. Committing per file also means a crash halfway
 * leaves the years it did finish in place, and the unique key makes the
 * re-run of those a no-op.
 */
export async function runPlayImport(importId: number): Promise<void> {
	const row = await loadImport(importId);
	if (!row) throw new Error(`No import ${importId}`);
	if (row.status !== 'queued' && row.status !== 'running') return;

	await db.execute(sql`
		update play_imports set status = 'running', started_at = now(), error = null
		 where id = ${importId}
	`);

	let source: Awaited<ReturnType<typeof openHistorySource>> | null = null;
	try {
		source = await openHistorySource(row.path);

		if (source.files.length === 0) {
			throw new Error(explainEmpty(source.shortFormFiles));
		}

		await db.execute(sql`
			update play_imports
			   set files = ${source.files.length},
			       meta = meta || ${JSON.stringify({ files: source.files.map((f) => f.name) })}::jsonb
			 where id = ${importId}
		`);

		let rowsRead = 0;
		let inserted = 0;
		let duplicates = 0;
		let earliest: string | null = null;
		let latest: string | null = null;

		for (const [index, file] of source.files.entries()) {
			const plays = parseHistoryFile(await file.read(), file.name);
			const result = await insertPlays(plays, { source: 'extended', importId });

			rowsRead += plays.length;
			inserted += result.inserted;
			duplicates += result.duplicates;
			for (const play of plays) {
				if (earliest === null || play.playedAt < earliest) earliest = play.playedAt;
				if (latest === null || play.playedAt > latest) latest = play.playedAt;
			}

			await db.execute(sql`
				update play_imports
				   set files_done = ${index + 1},
				       rows_read = ${rowsRead},
				       plays_inserted = ${inserted},
				       duplicates = ${duplicates},
				       first_played_at = ${earliest},
				       last_played_at = ${latest}
				 where id = ${importId}
			`);
		}

		// The export is authoritative over the span it covers, so the polled rows
		// inside it — which carry no ms_played and so cannot collide on the unique
		// key — give way to it.
		const superseded =
			earliest && latest
				? await dropSupersededPolls(new Date(earliest), new Date(latest))
				: 0;

		const linked = await linkPlays();
		const stats = await refreshPlayStats();

		await db.execute(sql`
			update play_imports
			   set status = 'completed', finished_at = now(),
			       meta = meta || ${JSON.stringify({ superseded, linked, recordings: stats.recordings })}::jsonb
			 where id = ${importId}
		`);
		await logEvent(
			null,
			'info',
			`Imported ${inserted.toLocaleString('en-US')} plays from ${row.label}`,
			{ rowsRead, duplicates, superseded, linked },
			'import'
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await db.execute(sql`
			update play_imports
			   set status = 'failed', finished_at = now(), error = ${message.slice(0, 2000)}
			 where id = ${importId}
		`);
		await logEvent(null, 'error', `History import failed: ${message}`, null, 'import');
		throw err;
	} finally {
		await source?.close();
		// An uploaded archive is ours to clean up; a folder the user pointed at
		// is emphatically not.
		if (row.temporary) await fs.rm(row.path, { force: true }).catch(() => {});
	}
}

/**
 * The "wrong export" message.
 *
 * Requesting the account data rather than the extended history is by far the
 * most likely way to end up here — it arrives in days rather than a month, so
 * it is the one people have. Its `StreamingHistory_music_N.json` covers a
 * single year, times each play to the minute, and names no track URI at all;
 * every play in it is also in the extended export, so importing it would
 * double-count the overlap with nothing to match on. Saying which file was
 * found is what turns a dead end into a next step.
 */
function explainEmpty(shortForm: string[]): string {
	if (shortForm.length > 0) {
		return (
			`Found ${shortForm[0]} — that is the basic "Account data" export, which ` +
			'covers one year, times plays to the minute and carries no track ids. ' +
			'Request "Extended streaming history" from Spotify\'s privacy page instead; ' +
			'it arrives in about a month and contains Streaming_History_Audio_*.json.'
		);
	}
	return 'No Streaming_History_Audio_*.json files in this archive.';
}

async function loadImport(id: number): Promise<ImportRow | null> {
	const rows = await query<ImportRow>(sql`
		select id, label, path, kind, temporary, status from play_imports where id = ${id}
	`);
	return rows[0] ?? null;
}
