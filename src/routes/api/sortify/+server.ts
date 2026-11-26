import { handle, json } from '$lib/server/sortify/http.ts';
import { sortifyStatus } from '$lib/server/sortify/status.ts';
import type { RequestHandler } from './$types';

/**
 * Sortify's API: the iOS app that sorts liked songs into playlists keeps no
 * Spotify sign-in and no model key of its own; everything it shows and does
 * goes through these routes. Unauthenticated like every route here — the host
 * is tailnet-only. See the README for the whole surface.
 *
 * GET /api/sortify — the account, whether the grant covers playlist writes and
 * playback (with the re-authorization link when it does not), the mirror's
 * freshness and the model settings.
 */
export const GET: RequestHandler = ({ url }) => handle(url, async () => json(await sortifyStatus(url.origin)));
