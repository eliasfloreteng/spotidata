import { error, json } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { query } from '$lib/server/db/index.ts';
import { keepPlaylist } from '$lib/server/engine/client.ts';
import { keptPlaylists } from '$lib/server/engine/downloads.ts';
import { engineRoute, jsonBody } from '$lib/server/engine/http.ts';
import type { RequestHandler } from './$types';

/**
 * `{kept}`: has the engine keep the playlist in the music folder (download
 * every track and write its `.m3u8`, following it as it changes), or stop.
 * Stopping never deletes a track; it removes the playlist file unless it was
 * edited since.
 */
export const PUT: RequestHandler = async ({ params, request }) => {
	if (!/^[A-Za-z0-9]{1,40}$/.test(params.id)) error(400, 'Not a playlist id.');
	const body = (await jsonBody(request)) as { kept?: unknown } | null;
	if (typeof body?.kept !== 'boolean') error(400, 'Expected {kept: true | false}.');
	const kept = body.kept;
	const [row] = await query<{ listed: boolean }>(
		sql`select removed_at is null as listed from playlists where id = ${params.id}`
	);
	return engineRoute(async () => {
		await keepPlaylist(params.id, kept, row?.listed ?? false);
		const keeping = (await keptPlaylists([params.id]))[params.id];
		return json(keeping ?? { kept, file: null, error: null }, { headers: { 'cache-control': 'no-store' } });
	});
};
