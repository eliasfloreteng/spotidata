import { error, fail, redirect } from '@sveltejs/kit';
import {
	addSource,
	automationForPlaylist,
	automationSources,
	contributedTracks,
	deleteAutomation,
	getAutomation,
	linkPlaylist,
	pendingTracks,
	pickablePlaylists,
	removeSource,
	unlinkPlaylist,
	updateAutomation
} from '$lib/server/entities/automations.ts';
import { PAGE_SIZE, pageParam, paged, searchParam } from '$lib/server/entities/shared.ts';
import { ensureEntity } from '$lib/server/ingest/ensure.ts';
import { runAutomation } from '$lib/server/playlists/automations.ts';
import { PlaylistScopeError } from '$lib/server/playlists/sync.ts';
import { canWritePlaylists, readAuthState } from '$lib/server/spotify/auth.ts';
import { SpotifyRateLimited } from '$lib/server/spotify/errors.ts';
import { parseSpotifyId } from '$lib/utils/spotify-uri.ts';
import type { Actions, PageServerLoad } from './$types';

/** The ledger is history, not a working list — one screen of it is plenty. */
const HISTORY_ROWS = 20;

export const load: PageServerLoad = async ({ params, url }) => {
	const automation = await getAutomation(params.id);
	if (!automation) error(404, 'No such automation');

	const page = pageParam(url);
	const q = searchParam(url);

	const [sources, pending, contributed, playlists, auth] = await Promise.all([
		automationSources(params.id),
		pendingTracks(params.id, { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE, q }),
		contributedTracks(params.id, { limit: HISTORY_ROWS, offset: 0 }),
		pickablePlaylists(),
		readAuthState()
	]);

	return {
		automation,
		sources,
		...paged(pending, page, PAGE_SIZE),
		q,
		contributed,
		playlists,
		canWrite: canWritePlaylists(auth?.scope) && !auth?.needsReauth
	};
};

export const actions: Actions = {
	/**
	 * Accepts a playlist id from the picker or a pasted link. A link may point at
	 * a playlist this database has never seen, so it is fetched on demand — but
	 * the source is attached either way: the run refreshes its sources anyway,
	 * and a slow fetch is no reason to lose the thing you just asked for.
	 */
	addSource: async ({ params, request }) => {
		const form = await request.formData();
		const raw = String(form.get('playlist') ?? '').trim();
		if (!raw) return fail(400, { error: 'Pick a playlist or paste a link to one.' });

		const parsed = parseSpotifyId(raw);
		if (parsed && parsed.kind !== 'playlist') {
			return fail(400, { error: `That link points at ${parsed.kind === 'album' || parsed.kind === 'artist' ? 'an' : 'a'} ${parsed.kind}, not a playlist.` });
		}
		const playlistId = parsed?.id ?? (/^[A-Za-z0-9]{16,30}$/.test(raw) ? raw : null);
		if (!playlistId) return fail(400, { error: 'That is not a Spotify playlist link or id.' });

		const automation = await getAutomation(params.id);
		if (automation?.spotifyPlaylistId === playlistId) {
			return fail(400, {
				error: 'That is this automation’s own destination — it would feed itself.'
			});
		}

		const known = (await pickablePlaylists()).find((p) => p.id === playlistId);
		if (!known) {
			const state = await ensureEntity('playlist', playlistId);
			if (state.missing) return fail(404, { error: 'Spotify does not serve that playlist.' });
		}

		await addSource(params.id, playlistId, known?.name ?? null);
		return { added: true };
	},

	/**
	 * Points the automation at a playlist that already exists rather than letting
	 * it create one. Refused for a playlist somebody else owns: Spotify rejects
	 * the add with a 403 that explains nothing, and finding that out at the first
	 * run is worse than finding it out here.
	 */
	link: async ({ params, request }) => {
		const form = await request.formData();
		const raw = String(form.get('playlist') ?? '').trim();
		if (!raw) return fail(400, { error: 'Paste a link to the playlist, or pick one.' });

		const parsed = parseSpotifyId(raw);
		if (parsed && parsed.kind !== 'playlist') {
			return fail(400, { error: 'That link does not point at a playlist.' });
		}
		const playlistId = parsed?.id ?? (/^[A-Za-z0-9]{16,30}$/.test(raw) ? raw : null);
		if (!playlistId) return fail(400, { error: 'That is not a Spotify playlist link or id.' });

		const automation = await getAutomation(params.id);
		if (automation?.sources.includes(playlistId)) {
			return fail(400, { error: 'That playlist is one of the sources — it cannot also be the destination.' });
		}

		const owner = await automationForPlaylist(playlistId);
		if (owner && owner !== params.id) {
			return fail(400, { error: `Another automation (${owner}) already fills that playlist.` });
		}

		let known = (await pickablePlaylists()).find((p) => p.id === playlistId);
		if (!known) {
			const state = await ensureEntity('playlist', playlistId);
			if (state.missing) return fail(404, { error: 'Spotify does not serve that playlist.' });
			known = (await pickablePlaylists()).find((p) => p.id === playlistId);
			if (!known) {
				return fail(409, {
					error: 'Still fetching that playlist — try again in a moment.'
				});
			}
		}
		if (!known.isOwned) {
			return fail(400, { error: 'That playlist belongs to somebody else, so nothing can be added to it.' });
		}

		await linkPlaylist(params.id, playlistId);
		return { linked: true };
	},

	removeSource: async ({ params, request }) => {
		const form = await request.formData();
		await removeSource(params.id, String(form.get('playlist') ?? ''));
		return { removed: true };
	},

	settings: async ({ params, request }) => {
		const form = await request.formData();
		const name = String(form.get('name') ?? '')
			.trim()
			.slice(0, 100);
		const description = String(form.get('description') ?? '')
			.trim()
			.slice(0, 250);
		if (!name) return fail(400, { error: 'An automation needs a name.' });

		await updateAutomation(params.id, {
			name,
			description: description || null,
			autoRun: form.get('autoRun') === 'on',
			backfill: form.get('backfill') === 'on',
			playlistPublic: form.get('playlistPublic') === 'on'
		});
		return { saved: true };
	},

	/**
	 * Runs inline rather than queueing: it is a handful of requests, and somebody
	 * who just pressed the button should see the failure — a missing scope, a
	 * rate limit — instead of a job quietly retrying out of sight.
	 */
	run: async ({ params }) => {
		try {
			const result = await runAutomation(params.id);
			return { run: result };
		} catch (err) {
			if (err instanceof PlaylistScopeError) return fail(403, { error: err.message });
			if (err instanceof SpotifyRateLimited) {
				return fail(429, {
					error: `Spotify is rate limiting — try again after ${err.until.toLocaleTimeString()}. The hourly run will pick it up on its own.`
				});
			}
			return fail(502, { error: err instanceof Error ? err.message : String(err) });
		}
	},

	unlink: async ({ params }) => {
		await unlinkPlaylist(params.id);
		return { unlinked: true };
	},

	delete: async ({ params }) => {
		await deleteAutomation(params.id);
		redirect(303, '/automations');
	}
};
