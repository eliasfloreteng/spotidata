import fs from 'node:fs/promises';
import path from 'node:path';
import { fail } from '@sveltejs/kit';
import { config } from '$lib/server/config.ts';
import { listImports, queueImport, undoImport } from '$lib/server/import/queue.ts';
import { retryUnresolved } from '$lib/server/ingest/upsert-plays.ts';
import { coverage } from '$lib/server/stats/plays.ts';
import { getWorkerUtils } from '$lib/server/queue/runner.ts';
import { readAuthState } from '$lib/server/spotify/auth.ts';
import { SPOTIFY_SCOPE_STRING } from '$lib/server/config.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const [imports, stats, auth] = await Promise.all([listImports(), coverage(), readAuthState()]);

	// The recently-played scope arrived after the first release, so an older
	// grant has everything except the one this page depends on.
	const granted = new Set((auth?.scope ?? '').split(' ').filter(Boolean));
	const missingScopes = SPOTIFY_SCOPE_STRING.split(' ').filter((s) => !granted.has(s));

	return {
		imports,
		stats,
		missingScopes,
		maxUploadMb: Math.round(config.history.maxUploadBytes / 1024 / 1024)
	};
};

export const actions: Actions = {
	/**
	 * Imports from a path on this machine.
	 *
	 * The alternative to a 500 MB upload, and the better one when the app and
	 * the download live on the same computer — which for a single-user local
	 * monolith is the normal case. Nothing is copied and nothing is deleted
	 * afterwards: the folder is the user's.
	 */
	fromPath: async ({ request }) => {
		const form = await request.formData();
		const raw = String(form.get('path') ?? '').trim();
		if (!raw) return fail(400, { error: 'Give a path to the export folder or .zip' });

		const target = path.resolve(raw.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));

		let stat;
		try {
			stat = await fs.stat(target);
		} catch {
			return fail(400, { error: `Nothing at ${target}` });
		}

		const id = await queueImport({
			label: path.basename(target),
			path: target,
			kind: stat.isDirectory() ? 'folder' : 'zip',
			sizeBytes: stat.isDirectory() ? null : stat.size,
			temporary: false
		});
		return { queued: id };
	},

	/** Deletes an import and the plays it contributed. */
	undo: async ({ request }) => {
		const form = await request.formData();
		const id = Number(form.get('id'));
		if (!Number.isFinite(id)) return fail(400, { error: 'Bad import id' });
		const removed = await undoImport(id);
		return { undone: removed };
	},

	/**
	 * Clears the "already asked" marks on plays Spotify had no track for, so the
	 * next sync tries them again — worth doing after a track returns to the
	 * catalogue, and pointless otherwise.
	 */
	retry: async () => {
		const cleared = await retryUnresolved();
		const utils = await getWorkerUtils();
		await utils.addJob('sync:start', { mode: 'incremental', trigger: 'history-retry' }, {
			jobKey: 'sync:start:manual'
		});
		return { retried: cleared };
	}
};
