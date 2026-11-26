import { apiError, handle, json } from '$lib/server/sortify/http.ts';
import { wakeUrl } from '$lib/server/sortify/player.ts';
import type { RequestHandler } from './$types';

/**
 * GET ?redirect=<app scheme URL> — the link that bounces through the Spotify
 * app so it starts and registers as a Connect device, then returns to the app
 * (see `wakeUrl`). The redirect must be registered on the Spotify app.
 */
export const GET: RequestHandler = ({ url }) =>
	handle(url, async () => {
		const redirect = url.searchParams.get('redirect') ?? '';
		if (!/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(redirect) || /^https?:/i.test(redirect)) {
			return apiError(400, 'invalid', 'redirect must be an app URL such as reelsforspotify://callback.');
		}
		return json({ url: wakeUrl(redirect) });
	});
