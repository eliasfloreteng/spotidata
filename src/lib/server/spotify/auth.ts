import { eq, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../db/index.ts';
import { authTokens, authStates } from '../db/schema/index.ts';
import { config, SPOTIFY_SCOPE_STRING } from '../config.ts';
import { SpotifyAuthExpired } from './errors.ts';

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';

/** Refresh this many seconds before the access token actually expires. */
const REFRESH_SKEW_SECONDS = 60;

interface TokenResponse {
	access_token: string;
	token_type: string;
	expires_in: number;
	refresh_token?: string;
	scope?: string;
}

function basicAuthHeader(): string {
	const raw = `${config.spotify.clientId}:${config.spotify.clientSecret}`;
	return `Basic ${Buffer.from(raw).toString('base64')}`;
}

// ------------------------------------------------------------ authorize URL

export async function createAuthorizeUrl(): Promise<string> {
	const state = randomBytes(24).toString('base64url');
	await db.insert(authStates).values({
		state,
		expiresAt: new Date(Date.now() + 10 * 60_000)
	});
	// Opportunistic cleanup; this table should never hold more than a few rows.
	await db.delete(authStates).where(sql`${authStates.expiresAt} < now()`);

	const params = new URLSearchParams({
		client_id: config.spotify.clientId,
		response_type: 'code',
		redirect_uri: config.spotify.redirectUri,
		state,
		scope: SPOTIFY_SCOPE_STRING,
		// Force the consent screen so re-authorization after expiry actually
		// mints a fresh refresh token rather than silently reusing the grant.
		show_dialog: 'true'
	});
	return `${AUTHORIZE_URL}?${params}`;
}

export async function consumeState(state: string): Promise<boolean> {
	const deleted = await db
		.delete(authStates)
		.where(eq(authStates.state, state))
		.returning({ state: authStates.state });
	return deleted.length > 0;
}

// ---------------------------------------------------------- code → tokens

export async function exchangeCode(code: string): Promise<void> {
	const res = await fetch(TOKEN_URL, {
		method: 'POST',
		headers: {
			Authorization: basicAuthHeader(),
			'Content-Type': 'application/x-www-form-urlencoded'
		},
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			redirect_uri: config.spotify.redirectUri
		})
	});

	if (!res.ok) {
		throw new Error(`Token exchange failed (${res.status}): ${await res.text()}`);
	}

	const tok = (await res.json()) as TokenResponse;
	if (!tok.refresh_token) {
		throw new Error('Token exchange returned no refresh_token');
	}

	const now = new Date();
	await db
		.insert(authTokens)
		.values({
			id: 1,
			accessToken: tok.access_token,
			refreshToken: tok.refresh_token,
			tokenType: tok.token_type,
			scope: tok.scope ?? SPOTIFY_SCOPE_STRING,
			accessExpiresAt: new Date(now.getTime() + tok.expires_in * 1000),
			// The 180-day refresh clock starts HERE and is never bumped again.
			authorizedAt: now,
			needsReauth: false,
			lastRefreshError: null
		})
		.onConflictDoUpdate({
			target: authTokens.id,
			set: {
				accessToken: sql`excluded.access_token`,
				refreshToken: sql`excluded.refresh_token`,
				tokenType: sql`excluded.token_type`,
				scope: sql`excluded.scope`,
				accessExpiresAt: sql`excluded.access_expires_at`,
				authorizedAt: sql`excluded.authorized_at`,
				needsReauth: false,
				lastRefreshError: null,
				updatedAt: sql`now()`
			}
		});
}

// ------------------------------------------------------------ access token

export interface AuthState {
	accessToken: string;
	accessExpiresAt: Date;
	refreshExpiresAt: Date | null;
	authorizedAt: Date;
	needsReauth: boolean;
	scope: string;
}

export async function readAuthState(): Promise<AuthState | null> {
	const [row] = await db.select().from(authTokens).where(eq(authTokens.id, 1));
	if (!row) return null;
	return {
		accessToken: row.accessToken,
		accessExpiresAt: row.accessExpiresAt,
		refreshExpiresAt: row.refreshExpiresAt,
		authorizedAt: row.authorizedAt,
		needsReauth: row.needsReauth,
		scope: row.scope
	};
}

/**
 * Single-flight refresh: concurrent callers within one process share one
 * in-flight request. Across processes the `FOR UPDATE` row lock in
 * `refreshAccessToken` serializes them, so at worst we do one redundant
 * refresh — harmless, since Spotify's refresh tokens do not rotate.
 */
let inFlight: Promise<string> | null = null;

export async function getAccessToken(): Promise<string> {
	const state = await readAuthState();
	if (!state) throw new SpotifyAuthExpired('Not authorized yet — visit /auth/login');
	if (state.needsReauth) throw new SpotifyAuthExpired();

	const expiresInMs = state.accessExpiresAt.getTime() - Date.now();
	if (expiresInMs > REFRESH_SKEW_SECONDS * 1000) return state.accessToken;

	inFlight ??= refreshAccessToken().finally(() => {
		inFlight = null;
	});
	return inFlight;
}

export async function refreshAccessToken(): Promise<string> {
	const client = await db.$client.connect();
	try {
		await client.query('BEGIN');
		const { rows } = await client.query<{
			refresh_token: string;
			access_token: string;
			access_expires_at: Date;
		}>(
			`SELECT refresh_token, access_token, access_expires_at
			   FROM auth_tokens WHERE id = 1 FOR UPDATE`
		);
		const row = rows[0];
		if (!row) throw new SpotifyAuthExpired('Not authorized yet — visit /auth/login');

		// Another process may have refreshed while we waited on the lock.
		if (row.access_expires_at.getTime() - Date.now() > REFRESH_SKEW_SECONDS * 1000) {
			await client.query('COMMIT');
			return row.access_token;
		}

		const res = await fetch(TOKEN_URL, {
			method: 'POST',
			headers: {
				Authorization: basicAuthHeader(),
				'Content-Type': 'application/x-www-form-urlencoded'
			},
			body: new URLSearchParams({
				grant_type: 'refresh_token',
				refresh_token: row.refresh_token
			})
		});

		const bodyText = await res.text();

		if (!res.ok) {
			// 400 invalid_grant means the 180-day window elapsed (or the user
			// revoked access). Nothing but a fresh authorization will fix it, so
			// flag it loudly instead of retrying forever.
			const isInvalidGrant = res.status === 400 && bodyText.includes('invalid_grant');
			await client.query(
				`UPDATE auth_tokens
				    SET last_refresh_error = $1, needs_reauth = $2, updated_at = now()
				  WHERE id = 1`,
				[`${res.status}: ${bodyText.slice(0, 300)}`, isInvalidGrant]
			);
			await client.query('COMMIT');
			if (isInvalidGrant) throw new SpotifyAuthExpired();
			throw new Error(`Token refresh failed (${res.status}): ${bodyText}`);
		}

		const tok = JSON.parse(bodyText) as TokenResponse;
		const accessExpiresAt = new Date(Date.now() + tok.expires_in * 1000);

		// Spotify does not rotate refresh tokens, but honour one if it appears.
		// authorized_at is deliberately NOT touched: the 180-day clock runs from
		// the original grant and refreshing does not extend it.
		await client.query(
			`UPDATE auth_tokens
			    SET access_token = $1,
			        access_expires_at = $2,
			        refresh_token = COALESCE($3, refresh_token),
			        scope = COALESCE($4, scope),
			        last_refresh_at = now(),
			        last_refresh_error = NULL,
			        needs_reauth = false,
			        updated_at = now()
			  WHERE id = 1`,
			[tok.access_token, accessExpiresAt, tok.refresh_token ?? null, tok.scope ?? null]
		);
		await client.query('COMMIT');
		return tok.access_token;
	} catch (err) {
		await client.query('ROLLBACK').catch(() => {});
		throw err;
	} finally {
		client.release();
	}
}

export async function logout(): Promise<void> {
	await db.delete(authTokens).where(eq(authTokens.id, 1));
}
