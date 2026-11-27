import { fail } from '@sveltejs/kit';
import {
	checkPlaylist,
	checkSpotify,
	engineDownloads,
	engineError,
	EngineRefused,
	keepPlaylist,
	removeDownload,
	retryDownload,
	setChecksPaused,
	setDownloadSettings,
	spotifyActivity,
	spotifyStatus,
	type Activity,
	type SpotifyStatus
} from '$lib/server/engine/client.ts';
import { statusesFor } from '$lib/server/engine/downloads.ts';
import { read, readQueue } from '$lib/server/engine/queue.ts';
import { searchCatalog, type CatalogTrack } from '$lib/server/engine/search.ts';
import { searchParam } from '$lib/server/entities/shared.ts';
import type { DownloadStatus } from '$lib/downloads.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	const q = searchParam(url);
	const [queue, activity, found] = await Promise.all([
		readQueue(),
		read<Activity[]>(() => spotifyActivity(30)),
		// Get Music: Spotify's catalog, as the apps search it.
		q ? searchCatalog(q, 30).catch(() => null) : Promise.resolve([] as CatalogTrack[])
	]);

	const results: Record<string, DownloadStatus> = found?.length
		? await statusesFor(found.map((t) => ({ id: t.id, isrc: t.isrc })))
		: {};

	return {
		q,
		...queue,
		// Describing every playlist takes the engine seconds, so it streams in
		// after the rest of the page.
		spotify: read<SpotifyStatus>(spotifyStatus),
		activity,
		found,
		results
	};
};

function id(form: FormData): number | null {
	const v = Number(form.get('id'));
	return Number.isInteger(v) && v > 0 ? v : null;
}

/** Runs an engine call for a form, answering what went wrong in the page's words. */
async function act(fn: () => Promise<unknown>) {
	try {
		await fn();
		return { ok: true };
	} catch (err) {
		return fail(err instanceof EngineRefused ? err.status : 503, { error: engineError(err) });
	}
}

export const actions: Actions = {
	retry: async ({ request }) => {
		const d = id(await request.formData());
		if (!d) return fail(400, { error: 'Not a download.' });
		return act(() => retryDownload(d));
	},

	/** Stops one under way, or forgets a finished one (its file stays). */
	remove: async ({ request }) => {
		const d = id(await request.formData());
		if (!d) return fail(400, { error: 'Not a download.' });
		return act(() => removeDownload(d));
	},

	retryFailed: async () =>
		act(async () => {
			const { downloads } = await engineDownloads();
			for (const d of downloads) if (d.state === 'failed') await retryDownload(d.id);
		}),

	/** Forgets every finished download in the list: the files stay where they are. */
	clearDone: async () =>
		act(async () => {
			const { downloads } = await engineDownloads();
			for (const d of downloads) if (d.state === 'done' || d.state === 'cancelled') await removeDownload(d.id);
		}),

	settings: async ({ request }) => {
		const form = await request.formData();
		return act(() => setDownloadSettings({ aiff: form.get('aiff') === 'on' }));
	},

	pause: async ({ request }) => {
		const form = await request.formData();
		return act(() => setChecksPaused(form.get('paused') === 'true'));
	},

	check: async () => act(checkSpotify),

	checkPlaylist: async ({ request }) => {
		const playlist = String((await request.formData()).get('playlist') ?? '');
		if (!playlist) return fail(400, { error: 'Not a playlist.' });
		return act(() => checkPlaylist(playlist));
	},

	stopKeeping: async ({ request }) => {
		const playlist = String((await request.formData()).get('playlist') ?? '');
		if (!playlist) return fail(400, { error: 'Not a playlist.' });
		return act(() => keepPlaylist(playlist, false, true));
	},

	/** Keeps any playlist by what you paste: a link, a short link, a `spotify:` URI or an id. */
	keepLink: async ({ request }) => {
		const link = String((await request.formData()).get('link') ?? '').trim();
		if (!link) return fail(400, { error: 'Paste a link to a Spotify playlist.' });
		return act(() => keepPlaylist(link, true, false));
	}
};
