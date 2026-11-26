import { error } from '@sveltejs/kit';
import { songRadio, type SongRadio } from '$lib/server/entities/radio.ts';
import { SpotifyAuthExpired, SpotifyRateLimited } from '$lib/server/spotify/errors.ts';
import { WebPlayerError } from '$lib/server/spotify/web-player.ts';
import type { PageServerLoad } from './$types';

/** A track's Spotify radio, by the track's Spotify id. Read live; nothing is stored. */
export const load: PageServerLoad = async ({ params }) => {
	if (!/^[A-Za-z0-9]{22}$/.test(params.id)) error(400, 'Not a Spotify track id.');

	let radio: SongRadio | null;
	try {
		radio = await songRadio(params.id);
	} catch (err) {
		if (err instanceof WebPlayerError) {
			error(502, `Spotify's web player answered ${err.status} when asked for this radio.`);
		}
		if (err instanceof SpotifyRateLimited) {
			error(503, `Spotify asked for a pause until ${err.until.toLocaleTimeString('en-GB')}.`);
		}
		if (err instanceof SpotifyAuthExpired) error(503, 'The Spotify sign-in has expired.');
		throw err;
	}
	if (!radio) error(404, 'Spotify has no radio for that track.');
	return { radio };
};
