import { boolean, check, integer, smallint, text, uniqueIndex, jsonb } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { table, ts, tsNow, externalUrls, provenance } from './_shared.ts';

export const spotifyUsers = table(
	'spotify_users',
	{
		id: text().primaryKey(),
		displayName: text(),
		href: text(),
		uri: text(),
		externalUrls: externalUrls(),
		followersTotal: integer(),
		/** True for exactly one row: the account this instance belongs to. */
		isMe: boolean().notNull().default(false),
		// Only populated for `isMe`; requires user-read-private / user-read-email.
		email: text(),
		country: text(),
		product: text(),
		explicitFilterEnabled: boolean(),
		explicitFilterLocked: boolean(),
		...provenance
	},
	(t) => [uniqueIndex('spotify_users_me_uq').on(sql`(true)`).where(sql`${t.isMe}`)]
);

/**
 * The single OAuth grant. One row, enforced by a CHECK on the primary key.
 *
 * `authorizedAt` records the ORIGINAL authorization and is never bumped on
 * refresh: Spotify's refresh tokens expire 6 months from first grant, do not
 * rotate, and refreshing does not extend the clock. `refreshExpiresAt` is a
 * stored generated column so the countdown is always correct by construction.
 */
export const authTokens = table(
	'auth_tokens',
	{
		id: smallint().primaryKey().default(1),
		accessToken: text().notNull(),
		refreshToken: text().notNull(),
		tokenType: text().notNull().default('Bearer'),
		scope: text().notNull(),
		accessExpiresAt: ts().notNull(),
		authorizedAt: ts().notNull(),
		/**
		 * 180 days after the ORIGINAL grant.
		 *
		 * All timestamptz arithmetic in Postgres is merely STABLE (the result
		 * depends on the session TimeZone), and generated columns demand
		 * IMMUTABLE. Pinning both conversions to UTC makes the whole
		 * expression immutable while keeping the value an absolute instant.
		 */
		refreshExpiresAt: ts().generatedAlwaysAs(
			sql`((authorized_at AT TIME ZONE 'UTC' + interval '180 days') AT TIME ZONE 'UTC')`
		),
		lastRefreshAt: ts(),
		lastRefreshError: text(),
		/** Set when Spotify answers a refresh with 400 invalid_grant. */
		needsReauth: boolean().notNull().default(false),
		updatedAt: tsNow()
	},
	(t) => [check('auth_tokens_singleton', sql`${t.id} = 1`)]
);

/** Short-lived CSRF `state` values issued by /auth/login. */
export const authStates = table('auth_states', {
	state: text().primaryKey(),
	createdAt: tsNow(),
	expiresAt: ts().notNull()
});

export const settings = table('settings', {
	key: text().primaryKey(),
	value: jsonb().notNull(),
	updatedAt: tsNow()
});
