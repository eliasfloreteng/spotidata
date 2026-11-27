import { radioFailure, songRadio } from '../entities/radio.ts';
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
		// A refused call is a tool result: the model reads why and decides what to do.
		const failure = radioFailure(err);
		if (!failure) throw err;
		const wait = failure.retryAfterSeconds ? ` Do not retry for ${failure.retryAfterSeconds}s.` : '';
		return { text: failure.message + wait, isError: true };
	}
}
