import { apiError, body, handle, json, minPlays, strings } from '$lib/server/sortify/http.ts';
import { apply, type ApplyRow } from '$lib/server/sortify/sort.ts';
import type { RequestHandler } from './$types';

/**
 * POST {rows: [{song, playlists: [id]}]} — adds each song to the playlists
 * ticked for it, turns down the suggestions left unticked (never offered again)
 * and marks the songs reviewed. A row with no playlists skips the song.
 */
export const POST: RequestHandler = ({ url, request }) =>
	handle(url, async () => {
		const input = await body<{ rows?: unknown }>(request);
		const rows: ApplyRow[] = (Array.isArray(input.rows) ? input.rows : [])
			.filter((r): r is { song: string; playlists?: unknown } => typeof r?.song === 'string')
			.map((r) => ({ song: r.song, playlists: strings(r.playlists) }));
		if (rows.length === 0) return apiError(400, 'invalid', 'Send at least one row.');
		return json(await apply(rows, minPlays(url)));
	});
