import '../src/lib/server/config.ts';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

/**
 * Saves the OAuth grant to disk, and optionally the whole database.
 *
 * The grant is the one piece of state that cannot be rebuilt from Spotify:
 * everything else is a re-sync away, but a lost refresh token costs a manual
 * browser round-trip. `bun run db:reset` calls this first for exactly that
 * reason — dropping the Docker volume otherwise takes the token with it.
 *
 *   bun scripts/backup.ts            # auth only  → backups/auth.json
 *   bun scripts/backup.ts --full     # + pg_dump  → backups/spotidata-<ts>.sql
 */
const dir = path.resolve(process.cwd(), 'backups');
fs.mkdirSync(dir, { recursive: true });

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
	const { rows } = await client.query(`
		SELECT access_token, refresh_token, token_type, scope,
		       access_expires_at, authorized_at
		  FROM auth_tokens WHERE id = 1
	`);

	if (rows.length === 0) {
		console.log('[backup] no auth token stored — nothing to save');
	} else {
		const file = path.join(dir, 'auth.json');
		fs.writeFileSync(file, JSON.stringify(rows[0], null, 2));
		fs.chmodSync(file, 0o600);
		console.log(`[backup] auth grant → ${path.relative(process.cwd(), file)}`);
	}
} finally {
	await client.end();
}

if (process.argv.includes('--full')) {
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const out = path.join(dir, `spotidata-${stamp}.sql`);
	// node:child_process rather than Bun.spawnSync so this script also runs
	// under plain Node, same as the worker.
	const { spawnSync } = await import('node:child_process');
	const proc = spawnSync(
		'docker',
		['exec', 'spotidata-pg', 'pg_dump', '-U', 'spotidata', '-d', 'spotidata'],
		{ maxBuffer: 1024 * 1024 * 512 }
	);
	if (proc.status !== 0) {
		console.error('[backup] pg_dump failed:', proc.stderr?.toString().slice(0, 400));
		process.exit(1);
	}
	fs.writeFileSync(out, proc.stdout);
	console.log(`[backup] full dump → ${path.relative(process.cwd(), out)}`);
}
