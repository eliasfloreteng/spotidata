import { handle, json } from '$lib/server/sortify/http.ts';
import { state } from '$lib/server/sortify/player.ts';
import type { RequestHandler } from './$types';

/** GET — what Spotify is playing, where, and how far in; `null` when nothing is. */
export const GET: RequestHandler = ({ url }) => handle(url, async () => json(await state()));
