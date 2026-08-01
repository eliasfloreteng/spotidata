import { config } from '../config.ts';

/**
 * Committed contract test for the Spotify API.
 *
 * The published reference contradicts itself and the API is actively losing
 * endpoints, so the only trustworthy answer is a live probe. `sync:start`
 * runs this as a pre-flight and records the result into sync_events, which
 * turns a future removal into a named phase failure instead of a mystery.
 *
 * Expectations below are the values MEASURED on 2026-07-31.
 */

interface Probe {
	name: string;
	path: string;
	expect: number;
	note?: string;
}

const T = '11dFghVXANMlKmJXsNCbNl'; // Carly Rae Jepsen — Cut To The Feeling
const AL = '4aawyAB9vmqN3uQ7FjRGTy'; // Pitbull — Global Warming
const AR = '0TnOYISbd1XYRBk9myaseg'; // Pitbull
const rep = (id: string, n: number) => Array.from({ length: n }, () => id).join(',');

const PROBES: Probe[] = [
	{ name: 'GET /tracks/{id}', path: `/tracks/${T}`, expect: 200 },
	{ name: 'GET /tracks?ids= (50)', path: `/tracks?ids=${rep(T, 50)}`, expect: 200, note: 'BULK — 50× cheaper than per-track' },
	{ name: 'GET /albums?ids= (20)', path: `/albums?ids=${rep(AL, 20)}`, expect: 200, note: 'BULK — embeds first 50 tracks each' },
	{ name: 'GET /artists?ids= (50)', path: `/artists?ids=${rep(AR, 50)}`, expect: 200, note: 'BULK' },
	{ name: 'GET /albums/{id}/tracks', path: `/albums/${AL}/tracks?limit=50`, expect: 200 },
	{ name: 'GET /artists/{id}/albums', path: `/artists/${AR}/albums?limit=50`, expect: 200 },
	{ name: 'GET /artists/{id}/top-tracks', path: `/artists/${AR}/top-tracks`, expect: 200 },
	{ name: 'GET /search', path: '/search?q=daft&type=track&limit=50', expect: 200 },
	{ name: 'GET /markets', path: '/markets', expect: 200 },
	// Removed by Spotify in Nov 2024 — assert they STAY dead so we never build on them.
	{ name: 'GET /audio-features (dead)', path: `/audio-features/${T}`, expect: 403, note: 'removed 2024' },
	{ name: 'GET /recommendations (dead)', path: `/recommendations?seed_tracks=${T}`, expect: 404, note: 'removed 2024' },
	{ name: 'GET /related-artists (dead)', path: `/artists/${AR}/related-artists`, expect: 404, note: 'removed 2024' },
	{ name: 'editorial playlist (dead)', path: '/playlists/37i9dQZF1DXcBWIGoYBM5M', expect: 404, note: 'Spotify-owned playlists unreachable' }
];

export async function clientCredentialsToken(): Promise<string> {
	const res = await fetch('https://accounts.spotify.com/api/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'client_credentials',
			client_id: config.spotify.clientId,
			client_secret: config.spotify.clientSecret
		})
	});
	if (!res.ok) throw new Error(`client_credentials failed: ${res.status} ${await res.text()}`);
	return ((await res.json()) as { access_token: string }).access_token;
}

export interface ProbeResult {
	name: string;
	status: number;
	expect: number;
	ok: boolean;
	note?: string;
}

export async function probeApi(token: string): Promise<ProbeResult[]> {
	const out: ProbeResult[] = [];
	for (const p of PROBES) {
		let status = 0;
		try {
			const res = await fetch(`https://api.spotify.com/v1${p.path}`, {
				headers: { Authorization: `Bearer ${token}` }
			});
			status = res.status;
		} catch {
			status = -1;
		}
		out.push({ name: p.name, status, expect: p.expect, ok: status === p.expect, note: p.note });
		// Stay well under the limiter even though this bypasses it.
		await new Promise((r) => setTimeout(r, 350));
	}
	return out;
}
