import { handle, json, minPlays } from '$lib/server/sortify/http.ts';
import { playlistsTab } from '$lib/server/sortify/sort.ts';
import type { RequestHandler } from './$types';

/** GET ?min_plays= — every eligible playlist with how many songs are strongly suggested for it. */
export const GET: RequestHandler = ({ url }) => handle(url, async () => json(await playlistsTab(minPlays(url))));
