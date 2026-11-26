import { db } from '$lib/server/db/index.ts';
import { sql } from 'drizzle-orm';
import { listPlaylists } from '$lib/server/sortify/catalog.ts';
import { apiError, body, handle, json, strings } from '$lib/server/sortify/http.ts';
import { createPlaylist } from '$lib/server/sortify/writes.ts';
import type { RequestHandler } from './$types';

/**
 * GET — every playlist in the account, most recently added to first, with
 * whether Sortify sorts into it (`eligible`), why it is left out by default
 * (`exclusion`) and the user's override, if any.
 */
export const GET: RequestHandler = ({ url }) => handle(url, async () => json(await listPlaylists()));

/**
 * POST {name, description?, tracks: [track id], idea?} — a new private
 * playlist holding these songs. `idea` is a proposed playlist from the sort
 * mode's New tab, dropped once it exists.
 */
export const POST: RequestHandler = ({ url, request }) =>
	handle(url, async () => {
		const input = await body<{ name?: unknown; description?: unknown; tracks?: unknown; idea?: unknown }>(request);
		const name = typeof input.name === 'string' ? input.name.trim() : '';
		if (!name) return apiError(400, 'invalid', 'A playlist needs a name.');
		const description = typeof input.description === 'string' ? input.description.trim().slice(0, 300) : '';
		const { playlist, result } = await createPlaylist(name.slice(0, 100), description, strings(input.tracks));
		if (typeof input.idea === 'string') {
			await db.execute(sql`delete from sortify_ideas where id::text = ${input.idea}`);
		}
		return json({ playlist, ...result }, 201);
	});
