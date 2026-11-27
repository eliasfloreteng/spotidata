import { fail } from '@sveltejs/kit';
import {
	BIN,
	browseTracks,
	isDjSort,
	nextTracks,
	poolShape,
	setTracks,
	type BrowseFilters
} from '$lib/server/entities/dj.ts';
import { setRadio, type SetRadio } from '$lib/server/entities/dj-radio.ts';
import { INDEX_PAGE_SIZE, pageParam, paged, searchParam } from '$lib/server/entities/shared.ts';
import { saveSetAsPlaylist } from '$lib/server/playlists/dj.ts';
import { canWritePlaylists, readAuthState } from '$lib/server/spotify/auth.ts';
import { PlaylistScopeError, SpotifyRateLimited } from '$lib/server/spotify/errors.ts';
import {
	KEY_MODES,
	parseCamelot,
	TEMPO_TOLERANCES,
	type KeyMode,
	type TempoTolerance
} from '$lib/utils/music.ts';
import type { Actions, PageServerLoad } from './$types';

/** Long enough for a night; short enough that the URL stays a URL. */
const MAX_SET = 60;
const SUGGESTIONS = 40;

/**
 * The set lives in the URL as repeated `?s=`, in play order, so adding a
 * track is a plain link, the back button is undo, and a half-built set can be
 * bookmarked. Repeats are dropped: the same record twice in one set is a
 * mistake, never a plan.
 */
function setIds(values: unknown[]): string[] {
	const ids = values
		.map((v) => String(v).trim())
		.filter((v) => v.length > 0 && v.length <= 128);
	return [...new Set(ids)].slice(0, MAX_SET);
}

function bpmParam(url: URL, name: string): number | null {
	const n = Number.parseInt(url.searchParams.get(name) ?? '', 10);
	return Number.isFinite(n) && n > 0 && n < 400 ? n : null;
}

export const load: PageServerLoad = async ({ url }) => {
	const ids = setIds(url.searchParams.getAll('s'));
	const q = searchParam(url);

	const tolRaw = Number(url.searchParams.get('tol'));
	const tolerance: TempoTolerance = (TEMPO_TOLERANCES as readonly number[]).includes(tolRaw)
		? (tolRaw as TempoTolerance)
		: 6;
	const keysRaw = url.searchParams.get('keys') ?? '';
	const keyMode: KeyMode = keysRaw in KEY_MODES ? (keysRaw as KeyMode) : 'harmonic';

	// On unless turned off: the radio is what tells a record that mixes from
	// one that belongs in the set.
	const useRadio = url.searchParams.get('radio') !== 'off';

	if (ids.length > 0) {
		const [set, auth] = await Promise.all([setTracks(ids), readAuthState()]);
		const seed = set.at(-1) ?? null;
		const mixable = seed != null && seed.bpm != null && seed.camelot != null;
		// Newest first; a track without a file still has a radio worth asking.
		const radio: SetRadio | null =
			mixable && useRadio
				? await setRadio(set.map((t) => t.representativeTrackId).reverse())
				: null;
		const next = mixable
			? await nextTracks(seed.canonicalTrackId, {
					tolerance,
					keyMode,
					q,
					exclude: set.map((t) => t.canonicalTrackId),
					limit: SUGGESTIONS,
					radio: radio?.entries ?? []
				})
			: [];
		return {
			mode: 'set' as const,
			set,
			seed,
			next,
			q,
			tolerance,
			keyMode,
			useRadio,
			radio: radio && {
				heard: radio.heard,
				asked: radio.asked,
				tracks: radio.entries.length,
				problem: radio.problem
			},
			maxSet: MAX_SET,
			canWrite: canWritePlaylists(auth?.scope) && !auth?.needsReauth
		};
	}

	// Browsing: the pool, narrowed by tempo and key.
	let bpmMin = bpmParam(url, 'min');
	let bpmMax = bpmParam(url, 'max');
	if (bpmMin != null && bpmMax != null && bpmMin > bpmMax) [bpmMin, bpmMax] = [bpmMax, bpmMin];
	const code = url.searchParams.get('key');
	const filters: BrowseFilters = {
		bpmMin,
		bpmMax,
		camelot: parseCamelot(code) ? code : null,
		q
	};

	const sortRaw = url.searchParams.get('sort') ?? 'bpm';
	const sort = isDjSort(sortRaw) ? sortRaw : 'bpm';
	const dirRaw = url.searchParams.get('dir');
	const dir: 'asc' | 'desc' =
		dirRaw === 'asc' || dirRaw === 'desc' ? dirRaw : sort === 'bpm' || sort === 'key' ? 'asc' : 'desc';
	const page = pageParam(url);

	const [shape, rows] = await Promise.all([
		poolShape(filters),
		browseTracks({
			filters,
			sort,
			dir,
			limit: INDEX_PAGE_SIZE,
			offset: (page - 1) * INDEX_PAGE_SIZE
		})
	]);

	return {
		mode: 'browse' as const,
		shape,
		...paged(rows, page, INDEX_PAGE_SIZE),
		filters,
		sort,
		dir,
		bin: BIN,
		q
	};
};

export const actions: Actions = {
	/**
	 * Inline, not queued: a handful of requests, and the
	 * person who pressed it should see a missing scope or a rate limit now.
	 */
	save: async ({ request }) => {
		// The set rides in the form, not the action URL, which SvelteKit rewrites.
		const form = await request.formData();
		const ids = setIds(form.getAll('s'));
		const name = String(form.get('name') ?? '').trim().slice(0, 100);
		if (!name) return fail(400, { error: 'Give the set a name.' });
		if (ids.length === 0) return fail(400, { error: 'Add a track to the set first.' });
		try {
			return { saved: await saveSetAsPlaylist(name, ids) };
		} catch (err) {
			if (err instanceof PlaylistScopeError) return fail(403, { error: err.message });
			if (err instanceof SpotifyRateLimited) {
				return fail(429, {
					error: `Spotify is rate limiting — try again after ${err.until.toLocaleTimeString()}.`
				});
			}
			return fail(502, { error: err instanceof Error ? err.message : String(err) });
		}
	}
};
