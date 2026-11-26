import { handle, json } from '$lib/server/sortify/http.ts';
import { devices } from '$lib/server/sortify/player.ts';
import type { RequestHandler } from './$types';

/** GET — the Spotify Connect devices that can be played on. */
export const GET: RequestHandler = ({ url }) => handle(url, async () => json(await devices()));
