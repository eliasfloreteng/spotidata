import { error } from '@sveltejs/kit';
import { radioFailure, songRadio, type SongRadio } from '$lib/server/entities/radio.ts';
import type { PageServerLoad } from './$types';

/** A track's Spotify radio, by the track's Spotify id. Read live; nothing is stored. */
export const load: PageServerLoad = async ({ params }) => {
	if (!/^[A-Za-z0-9]{22}$/.test(params.id)) error(400, 'Not a Spotify track id.');

	let radio: SongRadio | null;
	try {
		radio = await songRadio(params.id);
	} catch (err) {
		const failure = radioFailure(err);
		if (!failure) throw err;
		console.error('[radio]', params.id, err);
		error(failure.status, failure.message);
	}
	if (!radio) error(404, 'Spotify has no radio for that track.');
	return { radio };
};
