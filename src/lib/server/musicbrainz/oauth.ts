import { eq, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../db/index.ts';
import { authStates, externalTokens } from '../db/schema/index.ts';
import { config } from '../config.ts';

/**
 * MusicBrainz OAuth 2.0.
 *
 * Nothing in the enrichment pipeline needs this. The read-only web service is
 * open to anyone with a polite User-Agent, and authenticating does not raise
 * the one-request-per-second ceiling — MusicBrainz rate-limits by IP.
 *
 * It is here because the grant is what any *write* would need: submitting
 * ISRCs and barcodes we hold but MusicBrainz does not, voting tags back, or
 * reading the account's own collections. The client attaches the token when
 * one exists and behaves identically when it does not.
 */

const AUTHORIZE_URL = 'https://musicbrainz.org/oauth2/authorize';
const TOKEN_URL = 'https://musicbrainz.org/oauth2/token';
const SERVICE = 'musicbrainz';

/** Refresh this many seconds before the access token actually expires. */
const REFRESH_SKEW_SECONDS = 60;

/**
 * Read-only by design. `profile` identifies the account; the submit scopes are
 * deliberately absent, so a leaked token cannot edit the database.
 */
export const MB_SCOPES = ['profile', 'collection'] as const;

interface TokenResponse {
	access_token: string;
	token_type?: string;
	expires_in?: number;
	refresh_token?: string;
	scope?: string;
	error?: string;
	error_description?: string;
}

export function isOAuthConfigured(): boolean {
	const { clientId, clientSecret, redirectUri } = config.musicbrainz.oauth;
	return Boolean(clientId && clientSecret && redirectUri);
}

export async function createAuthorizeUrl(): Promise<string> {
	if (!isOAuthConfigured()) {
		throw new Error('MusicBrainz OAuth is not configured — set MUSICBRAINZ_CLIENT_ID/SECRET/REDIRECT_URI');
	}
	// Reuses the Spotify flow's CSRF table; a state is a state, and prefixing
	// keeps the two callbacks from ever consuming each other's.
	const state = `mb:${randomBytes(24).toString('base64url')}`;
	await db.insert(authStates).values({ state, expiresAt: new Date(Date.now() + 10 * 60_000) });
	await db.delete(authStates).where(sql`${authStates.expiresAt} < now()`);

	const params = new URLSearchParams({
		client_id: config.musicbrainz.oauth.clientId,
		response_type: 'code',
		redirect_uri: config.musicbrainz.oauth.redirectUri,
		scope: MB_SCOPES.join(' '),
		state,
		// Without this MusicBrainz issues no refresh token and the grant dies
		// with the first access token, an hour later.
		access_type: 'offline'
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

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
	const res = await fetch(TOKEN_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			'User-Agent': config.musicbrainz.userAgent
		},
		body: new URLSearchParams({
			client_id: config.musicbrainz.oauth.clientId,
			client_secret: config.musicbrainz.oauth.clientSecret,
			...body
		})
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`MusicBrainz token endpoint ${res.status}: ${text.slice(0, 300)}`);
	return JSON.parse(text) as TokenResponse;
}

export async function exchangeCode(code: string): Promise<void> {
	const tok = await postToken({
		grant_type: 'authorization_code',
		code,
		redirect_uri: config.musicbrainz.oauth.redirectUri
	});
	if (tok.error) throw new Error(`${tok.error}: ${tok.error_description ?? ''}`);

	await db
		.insert(externalTokens)
		.values({
			service: SERVICE,
			accessToken: tok.access_token,
			refreshToken: tok.refresh_token ?? null,
			tokenType: tok.token_type ?? 'Bearer',
			scope: tok.scope ?? MB_SCOPES.join(' '),
			accessExpiresAt: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000) : null,
			authorizedAt: new Date(),
			lastRefreshError: null
		})
		.onConflictDoUpdate({
			target: externalTokens.service,
			set: {
				accessToken: sql`excluded.access_token`,
				refreshToken: sql`excluded.refresh_token`,
				tokenType: sql`excluded.token_type`,
				scope: sql`excluded.scope`,
				accessExpiresAt: sql`excluded.access_expires_at`,
				authorizedAt: sql`excluded.authorized_at`,
				lastRefreshError: null,
				updatedAt: sql`now()`
			}
		});
}

export interface MbAuthState {
	scope: string;
	authorizedAt: Date;
	accessExpiresAt: Date | null;
	hasRefreshToken: boolean;
	lastRefreshError: string | null;
}

export async function readAuthState(): Promise<MbAuthState | null> {
	const [row] = await db.select().from(externalTokens).where(eq(externalTokens.service, SERVICE));
	if (!row) return null;
	return {
		scope: row.scope,
		authorizedAt: row.authorizedAt,
		accessExpiresAt: row.accessExpiresAt,
		hasRefreshToken: Boolean(row.refreshToken),
		lastRefreshError: row.lastRefreshError
	};
}

export async function revoke(): Promise<void> {
	await db.delete(externalTokens).where(eq(externalTokens.service, SERVICE));
}

let inFlight: Promise<string | null> | null = null;

/**
 * The token to send, or null — which is the normal case and never an error.
 *
 * A failed refresh is recorded and swallowed for the same reason: enrichment
 * works unauthenticated, so a stale grant must degrade to anonymous rather
 * than halt a crawl that was going to succeed anyway.
 */
export async function getBearerToken(): Promise<string | null> {
	if (!isOAuthConfigured()) return null;

	const [row] = await db.select().from(externalTokens).where(eq(externalTokens.service, SERVICE));
	if (!row) return null;

	const expiresInMs = row.accessExpiresAt ? row.accessExpiresAt.getTime() - Date.now() : Infinity;
	if (expiresInMs > REFRESH_SKEW_SECONDS * 1000) return row.accessToken;
	if (!row.refreshToken) return null;

	inFlight ??= refreshAccessToken(row.refreshToken).finally(() => {
		inFlight = null;
	});
	return inFlight;
}

async function refreshAccessToken(refreshToken: string): Promise<string | null> {
	try {
		const tok = await postToken({ grant_type: 'refresh_token', refresh_token: refreshToken });
		if (tok.error || !tok.access_token) {
			throw new Error(`${tok.error ?? 'no access_token'}: ${tok.error_description ?? ''}`);
		}
		await db
			.update(externalTokens)
			.set({
				accessToken: tok.access_token,
				refreshToken: tok.refresh_token ?? refreshToken,
				accessExpiresAt: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000) : null,
				lastRefreshError: null,
				updatedAt: new Date()
			})
			.where(eq(externalTokens.service, SERVICE));
		return tok.access_token;
	} catch (err) {
		await db
			.update(externalTokens)
			.set({ lastRefreshError: String(err).slice(0, 300), updatedAt: new Date() })
			.where(eq(externalTokens.service, SERVICE));
		return null;
	}
}
