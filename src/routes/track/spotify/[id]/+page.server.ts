import { error, redirect } from '@sveltejs/kit';
import { canonicalIdForSpotifyTrack } from '$lib/server/entities/track.ts';
import { ensureEntity } from '$lib/server/ingest/ensure.ts';
import type { PageServerLoad } from './$types';

/**
 * Resolves a Spotify track id to the recording that owns it.
 *
 * Everything in the app links by canonical id; this is the door for the other
 * direction — a pasted link, a bookmark from before a regrouping, or an id
 * that has never been seen at all.
 */
export const load: PageServerLoad = async ({ params }) => {
	const id = params.id;

	const known = await canonicalIdForSpotifyTrack(id);
	if (known) redirect(302, `/track/${encodeURIComponent(known)}`);

	const state = await ensureEntity('track', id);
	if (state.missing) error(404, 'Spotify has no track with that id.');

	// The ingest runs refresh_canonical_tracks() before it notifies, so a ready
	// result means the grouping already exists.
	const resolved = await canonicalIdForSpotifyTrack(id);
	if (resolved) redirect(302, `/track/${encodeURIComponent(resolved)}`);

	if (state.pending) return { id };
	error(404, 'That track exists but could not be grouped into a recording.');
};
