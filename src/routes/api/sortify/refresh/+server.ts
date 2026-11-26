import { handle, json } from '$lib/server/sortify/http.ts';
import { requestSync } from '$lib/server/sortify/status.ts';
import type { RequestHandler } from './$types';

/** POST — asks for an incremental sync unless one ran in the last half hour. */
export const POST: RequestHandler = ({ url }) => handle(url, async () => json(await requestSync(), 202));
