/**
 * Single source of environment truth for everything under `src/lib/server`.
 *
 * Nothing in this directory may import `$env/*`, `$lib`, or touch `Bun.*` —
 * the same modules are loaded both by SvelteKit (under Bun) and by
 * `worker/main.ts` (under plain Node), so they must stay runtime-agnostic.
 */

import fs from 'node:fs';
import os from 'node:os';
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

function list(name: string): string[] {
	return (process.env[name] ?? '')
		.split(',')
		.map((v) => v.trim())
		.filter(Boolean);
}

/** `cargo build --release` in `analyser/` puts it here; the image puts it on PATH. */
function localAnalyser(): string {
	const built = path.resolve(process.cwd(), 'analyser/target/release/rbx-analyse');
	return fs.existsSync(built) ? built : 'rbx-analyse';
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
			'user-read-email',
			// Listening history. Added after the first release, so an existing
			// grant does not carry it — the app compares this list against the
			// stored scope and asks for a re-authorization when they diverge.
			'user-read-recently-played',
			// The only write scopes the app itself uses: an automation appends
			// to a playlist, and the DJ tab saves a set as a new one. Both are
			// needed because the playlist's visibility is the user's choice and
			// Spotify scopes the two cases separately.
			'playlist-modify-private',
			'playlist-modify-public',
			// Nothing in the app itself uses these. They exist for the MCP
			// `spotify_api` tool, which passes arbitrary calls through and can
			// reach no further than this grant: saving and unsaving, following,
			// and reading and driving playback.
			'user-library-modify',
			'user-follow-modify',
			'user-read-playback-state',
			'user-modify-playback-state'
		] as const
	},

	/**
	 * rbxport's tempo and key, measured from Deezer's 30-second previews: the
	 * analysis that covers the whole library. `bin` is the `analyser/` binary —
	 * on PATH in the image, built in place in a checkout.
	 */
	analysis: {
		bin: process.env.RBX_ANALYSE_BIN ?? localAnalyser(),
		deezerUrl: process.env.DEEZER_API_URL ?? 'https://api.deezer.com'
	},

	worker: {
		mode: (process.env.WORKER_MODE ?? 'embedded') as WorkerMode,
		concurrency: int('WORKER_CONCURRENCY', 8)
	},

	history: {
		/**
		 * Where an uploaded export lands while the importer reads it. A Spotify
		 * archive runs to ~500 MB, so it goes to disk rather than through memory,
		 * and the importer deletes it once the last file is in.
		 */
		uploadDir: process.env.HISTORY_UPLOAD_DIR ?? path.join(os.tmpdir(), 'spotidata-uploads'),
		/** Refuse anything larger, rather than filling the disk to find out. */
		maxUploadBytes: int('HISTORY_MAX_UPLOAD_MB', 2048) * 1024 * 1024
	},

	mcp: {
		/** The role every MCP statement runs as; see db/sql/post/070_mcp_role.sql. */
		role: process.env.MCP_DB_ROLE ?? 'spotidata_mcp',
		statementTimeoutMs: int('MCP_STATEMENT_TIMEOUT_MS', 15_000),
		/**
		 * Browser origins allowed to reach /api/mcp. Empty by default, which is
		 * what a non-browser MCP client needs — it sends no Origin at all. This is
		 * not authentication (an OAuth proxy fronts the deployment); it is the
		 * DNS-rebinding guard the MCP spec asks local servers for, so that a page
		 * you happen to have open cannot read the database on 127.0.0.1.
		 */
		allowedOrigins: list('MCP_ALLOWED_ORIGINS')
	},

	isProduction: process.env.NODE_ENV === 'production'
};

export const SPOTIFY_SCOPE_STRING = config.spotify.scopes.join(' ');
