import { apiError, body, handle } from '$lib/server/sortify/http.ts';
import { pause, play, resume, seek } from '$lib/server/sortify/player.ts';
import type { RequestHandler } from './$types';

/**
 * PUT /api/sortify/player/play {track, position_ms, device}
 * PUT /api/sortify/player/pause|resume {device}
 * PUT /api/sortify/player/seek {position_ms, device}
 *
 * `device` is a Spotify Connect device id; the app always names one, so a
 * song never starts on whatever happened to be active. 409 `no_device` means
 * Spotify has nothing to play on.
 */
export const PUT: RequestHandler = ({ url, request, params }) =>
	handle(url, async () => {
		const input = await body<{ track?: unknown; position_ms?: unknown; device?: unknown }>(request);
		const device = typeof input.device === 'string' && input.device ? input.device : null;
		const position = typeof input.position_ms === 'number' ? input.position_ms : 0;
		switch (params.action) {
			case 'play':
				if (typeof input.track !== 'string' || !input.track) return apiError(400, 'invalid', 'Name the track.');
				await play(input.track, position, device);
				break;
			case 'pause':
				await pause(device);
				break;
			case 'resume':
				await resume(device);
				break;
			case 'seek':
				await seek(position, device);
				break;
			default:
				return apiError(404, 'not_found', `No player action ${params.action}.`);
		}
		return new Response(null, { status: 204 });
	});
