import { genreSelection, genreTrackIds, MAX_LINKS } from '$lib/server/entities/genres.ts';
import { spotifyLink } from '$lib/utils/spotify-uri.ts';
import type { RequestHandler } from './$types';

/**
 * The current genre selection as open.spotify.com track links, one per line.
 *
 * Text rather than JSON because both consumers want text: the page copies the
 * body to the clipboard, and opening this URL in a browser gives you the same
 * list to select by hand — which is the whole feature without any JavaScript.
 *
 * Web URLs, never `spotify:` URIs, regardless of the app's link-scheme
 * setting: pasting into a playlist is the destination here, and the desktop
 * client accepts both while every other surface accepts only the first.
 */
export const GET: RequestHandler = async ({ url }) => {
	const ids = await genreTrackIds(genreSelection(url), MAX_LINKS);
	const body = ids.map((id) => spotifyLink('track', id, 'web')).join('\n');

	return new Response(ids.length ? body + '\n' : '', {
		headers: {
			'content-type': 'text/plain; charset=utf-8',
			// The library moves under it — a cached list would paste yesterday's
			// selection into today's playlist.
			'cache-control': 'no-store',
			'x-track-count': String(ids.length)
		}
	});
};
