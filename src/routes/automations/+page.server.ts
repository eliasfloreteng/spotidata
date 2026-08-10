import { fail, redirect } from '@sveltejs/kit';
import {
	addSource,
	createAutomation,
	listAutomations,
	pickablePlaylists
} from '$lib/server/entities/automations.ts';
import { canWritePlaylists, readAuthState } from '$lib/server/spotify/auth.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const [automations, playlists, auth] = await Promise.all([
		listAutomations(),
		pickablePlaylists(),
		readAuthState()
	]);

	return {
		automations,
		playlists,
		canWrite: canWritePlaylists(auth?.scope) && !auth?.needsReauth
	};
};

export const actions: Actions = {
	/**
	 * Creating lands on the automation's own page, which is where sources are
	 * managed — but the sources picked here are attached first, because "the
	 * playlists in this folder" is the thought somebody is having while they
	 * name it, not a second errand.
	 */
	create: async ({ request }) => {
		const form = await request.formData();
		const name = String(form.get('name') ?? '')
			.trim()
			.slice(0, 100);
		if (!name) return fail(400, { error: 'Give the automation a name.' });

		const sources = form.getAll('source').map((s) => String(s).trim()).filter(Boolean);
		const backfill = form.get('backfill') !== 'new';

		const id = await createAutomation(name, { backfill });
		for (const playlistId of sources) await addSource(id, playlistId);
		redirect(303, `/automations/${id}`);
	}
};
