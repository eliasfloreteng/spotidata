import '../src/lib/server/config.ts';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

/**
 * Restores the OAuth grant saved by scripts/backup.ts.
 *
 * `authorized_at` is restored verbatim, never reset to now(): Spotify's
 * 180-day refresh window runs from the ORIGINAL authorization, so faking a
 * fresh timestamp would silently overstate how long the token has left.
 */
const file = path.resolve(process.cwd(), 'backups/auth.json');
if (!fs.existsSync(file)) {
	console.log('[restore] no backups/auth.json — sign in at /auth/login');
	process.exit(0);
}

const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as {
	access_token: string;
	refresh_token: string;
	token_type: string;
	scope: string;
	access_expires_at: string;
	authorized_at: string;
};

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
	await client.query(
		`INSERT INTO auth_tokens
		   (id, access_token, refresh_token, token_type, scope, access_expires_at, authorized_at)
		 VALUES (1, $1, $2, $3, $4, $5, $6)
		 ON CONFLICT (id) DO UPDATE SET
		   access_token = excluded.access_token,
		   refresh_token = excluded.refresh_token,
		   token_type = excluded.token_type,
		   scope = excluded.scope,
		   access_expires_at = excluded.access_expires_at,
		   authorized_at = excluded.authorized_at,
		   needs_reauth = false,
		   last_refresh_error = NULL,
		   updated_at = now()`,
		[
			saved.access_token,
			saved.refresh_token,
			saved.token_type,
			saved.scope,
			saved.access_expires_at,
			saved.authorized_at
		]
	);
	console.log('[restore] auth grant restored');
} finally {
	await client.end();
}
