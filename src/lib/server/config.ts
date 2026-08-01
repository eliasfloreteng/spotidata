/**
 * Single source of environment truth for everything under `src/lib/server`.
 *
 * Nothing in this directory may import `$env/*`, `$lib`, or touch `Bun.*` —
 * the same modules are loaded both by SvelteKit (under Bun) and by
 * `worker/main.ts` (under plain Node), so they must stay runtime-agnostic.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Load `.env` into process.env if the host has not already done it.
 *
 * SvelteKit/vite populates process.env in dev, but `bun scripts/*.ts` and the
 * Node worker do not. Doing it here rather than in each entrypoint removes an
 * import-ordering trap: any module that reaches `config` gets a populated
 * environment regardless of what imported it first.
 */
function loadDotEnvOnce(): void {
	if (process.env.DATABASE_URL) return;
	const file = path.resolve(process.cwd(), '.env');
	if (!fs.existsSync(file)) return;
	for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
		const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
		if (!m?.[1] || process.env[m[1]] !== undefined) continue;
		let value = m[2] ?? '';
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		process.env[m[1]] = value;
	}
}

loadDotEnvOnce();

function required(name: string): string {
	const v = process.env[name];
	if (!v) throw new Error(`Missing required environment variable ${name}`);
	return v;
}

function int(name: string, fallback: number): number {
	const v = process.env[name];
	if (!v) return fallback;
	const n = Number.parseInt(v, 10);
	return Number.isFinite(n) ? n : fallback;
}

export type WorkerMode = 'embedded' | 'external' | 'off';

export const config = {
	databaseUrl: required('DATABASE_URL'),

	spotify: {
		clientId: required('SPOTIFY_CLIENT_ID'),
		clientSecret: required('SPOTIFY_CLIENT_SECRET'),
		redirectUri: required('SPOTIFY_REDIRECT_URI'),
		scopes: [
			'user-library-read',
			'playlist-read-private',
			'playlist-read-collaborative',
			'user-follow-read',
			'user-read-private',
			'user-read-email'
		] as const
	},

	worker: {
		mode: (process.env.WORKER_MODE ?? 'embedded') as WorkerMode,
		concurrency: int('WORKER_CONCURRENCY', 8)
	},

	isProduction: process.env.NODE_ENV === 'production'
};

export const SPOTIFY_SCOPE_STRING = config.spotify.scopes.join(' ');
