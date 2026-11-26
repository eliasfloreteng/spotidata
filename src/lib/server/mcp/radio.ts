import { songRadio } from '../entities/radio.ts';
import { SpotifyAuthExpired, SpotifyRateLimited } from '../spotify/errors.ts';
import { WebPlayerError } from '../spotify/web-player.ts';
import { parseSpotifyId } from '../../utils/spotify-uri.ts';

/** The `song_radio` tool: a radio as JSON, or why there is none. */
export async function callSongRadio(input: string): Promise<{ text: string; isError: boolean }> {
	const raw = input.trim();
	const parsed = /^[A-Za-z0-9]{22}$/.test(raw) ? { kind: 'track', id: raw } : parseSpotifyId(raw);
	if (parsed?.kind !== 'track') {
		return { text: `"${raw}" is not a Spotify track id, spotify:track: URI or track link.`, isError: true };
	}
	try {
		const radio = await songRadio(parsed.id);
		if (!radio) return { text: `Spotify has no radio for track ${parsed.id}.`, isError: true };
		// Covers are for pages; to a model they are only tokens.
		const tracks = radio.tracks.map(({ cover: _cover, ...t }) => t);
		const { image: _image, ...head } = radio;
		return { text: JSON.stringify({ ...head, tracks }), isError: false };
	} catch (err) {
		if (err instanceof WebPlayerError) {
			const wait = err.retryAfterSeconds ? ` Retry after ${err.retryAfterSeconds}s.` : '';
			return { text: `Spotify's web-player API answered ${err.status} for ${err.path}.${wait}`, isError: true };
		}
		if (err instanceof SpotifyRateLimited) {
			return {
				text: `The radio was found, but filling in its tracks needs the Web API, which is rate limited until ${err.until.toISOString()}. Do not retry before then.`,
				isError: true
			};
		}
		if (err instanceof SpotifyAuthExpired) {
			return { text: 'The Spotify grant has expired. The user has to sign in to Spotidata again.', isError: true };
		}
		throw err;
	}
}
