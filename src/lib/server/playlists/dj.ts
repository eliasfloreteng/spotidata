import { sql } from 'drizzle-orm';
import { query } from '../db/index.ts';
import { getMe } from '../ingest/upsert-users.ts';
import { canWritePlaylists, readAuthState } from '../spotify/auth.ts';
import { addPlaylistItems, createPlaylist, PLAYLIST_ITEMS_PER_REQUEST } from '../spotify/endpoints.ts';
import { PlaylistScopeError } from '../spotify/errors.ts';
import { spotifyLink } from '../../utils/spotify-uri.ts';

/**
 * A set from the DJ tab, written out as a new Spotify playlist — which is also
 * how it reaches the DJ stick: Deckhand copies any playlist it is pointed at.
 *
 * Fire and forget: a set is a one-off, so nothing is stored here and nothing
 * keeps it in sync. Saving the same set twice makes
 * two playlists, which is what pressing the button twice should mean.
 */
export interface SavedSet {
	playlistId: string;
	tracks: number;
	requests: number;
}

export async function saveSetAsPlaylist(name: string, canonicalIds: string[]): Promise<SavedSet> {
	const auth = await readAuthState();
	if (!auth || auth.needsReauth || !canWritePlaylists(auth.scope)) throw new PlaylistScopeError();

	// The copy you keep, where there is one — it is the one that shows as
	// liked in Spotify — and otherwise the recording's representative.
	const rows = await query<{ trackId: string }>(sql`
		select coalesce(
		         (select lt.track_id
		            from library_tracks lt
		            join spotify_tracks st on st.id = lt.track_id
		           where st.canonical_track_id = ct.id
		           order by lt.via_liked desc, lt.first_added_at, lt.track_id
		           limit 1),
		         ct.representative_track_id
		       ) as "trackId"
		  from jsonb_array_elements_text(${JSON.stringify(canonicalIds)}::jsonb) with ordinality as s(id, ord)
		  join canonical_tracks ct on ct.id = s.id
		 order by s.ord
	`);
	if (rows.length === 0) throw new Error('The set is empty.');

	const me = await getMe();
	if (!me) throw new Error('No Spotify profile stored yet — run a sync first.');

	const playlist = await createPlaylist(me.id, {
		name,
		description: `A ${rows.length}-track set, mixed by key and tempo on Spotidata's DJ tab.`,
		public: false
	});
	let requests = 1;

	for (let i = 0; i < rows.length; i += PLAYLIST_ITEMS_PER_REQUEST) {
		const uris = rows
			.slice(i, i + PLAYLIST_ITEMS_PER_REQUEST)
			.map((r) => spotifyLink('track', r.trackId, 'uri'));
		await addPlaylistItems(playlist.id, uris);
		requests++;
	}

	return { playlistId: playlist.id, tracks: rows.length, requests };
}
