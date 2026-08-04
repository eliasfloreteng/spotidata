import { error, redirect } from '@sveltejs/kit';
import {
	getCanonicalTrack,
	getTrackCopies,
	getTrackPlaylists
} from '$lib/server/entities/track.ts';
import {
	recentPlaysFor,
	trackPlaySummary,
	trackPlaysByMonth
} from '$lib/server/entities/play-stats.ts';
import type { PageServerLoad } from './$types';

/** A raw Spotify id is base62 and 22 chars; a canonical id always has a colon. */
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;

export const load: PageServerLoad = async ({ params, locals }) => {
	const id = params.id;
	const track = await getCanonicalTrack(id);

	if (!track) {
		// Canonical rows are derived, so there is nothing to fetch for an unknown
		// canonical id. A pasted Spotify id, though, is resolvable — hand it to
		// /track/spotify/[id], which owns the on-demand fetch.
		if (SPOTIFY_ID.test(id)) redirect(302, `/track/spotify/${id}`);
		error(404, 'No recording with that id. It may have been regrouped by a newer sync.');
	}

	const [copies, playlists, plays, playsByMonth, recentPlays] = await Promise.all([
		getTrackCopies(id),
		getTrackPlaylists(id),
		trackPlaySummary(id),
		trackPlaysByMonth(id, locals.settings['ui.timezone']),
		// Six rows is what stands level with the chart beside it; the full log
		// lives at /history/log and this is a glance, not a list.
		recentPlaysFor(id, 6)
	]);
	return { track, copies, playlists, plays, playsByMonth, recentPlays };
};
