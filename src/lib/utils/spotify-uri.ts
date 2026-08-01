export type LinkScheme = 'uri' | 'web';
export type EntityKind = 'track' | 'album' | 'artist' | 'playlist' | 'user';

/**
 * Builds an outbound Spotify link.
 *
 * `uri` (the default) yields `spotify:track:…`, which the desktop app claims,
 * so links open in the client rather than a browser tab. `web` yields the
 * open.spotify.com URL for anyone without the app installed.
 */
export function spotifyLink(kind: EntityKind, id: string, scheme: LinkScheme = 'uri'): string {
	return scheme === 'uri'
		? `spotify:${kind}:${id}`
		: `https://open.spotify.com/${kind}/${id}`;
}

/** Extracts the bare id from either link form or a raw id. */
export function parseSpotifyId(input: string): { kind: EntityKind; id: string } | null {
	const uri = input.match(/^spotify:(track|album|artist|playlist|user):([A-Za-z0-9]+)$/);
	if (uri?.[1] && uri[2]) return { kind: uri[1] as EntityKind, id: uri[2] };

	const web = input.match(
		/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?(track|album|artist|playlist|user)\/([A-Za-z0-9]+)/
	);
	if (web?.[1] && web[2]) return { kind: web[1] as EntityKind, id: web[2] };

	return null;
}
