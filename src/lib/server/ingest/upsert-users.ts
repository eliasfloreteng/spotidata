import { sql, eq } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { spotifyUsers } from '../db/schema/index.ts';
import { me as fetchMe } from '../spotify/endpoints.ts';
import type { PublicUser, PrivateUser } from '../spotify/types.ts';

/**
 * Upserts a playlist owner or collaborator. These arrive as *public* user
 * objects with almost nothing on them, so this must never clobber the richer
 * columns that only `/me` supplies.
 */
export async function upsertPublicUser(user: PublicUser): Promise<void> {
	await db
		.insert(spotifyUsers)
		.values({
			id: user.id,
			displayName: user.display_name,
			href: user.href,
			uri: user.uri,
			externalUrls: user.external_urls ?? {},
			followersTotal: user.followers?.total ?? null,
			fetchedAt: new Date()
		})
		.onConflictDoUpdate({
			target: spotifyUsers.id,
			set: {
				// COALESCE keeps an existing display name if this payload omits it.
				displayName: sql`coalesce(excluded.display_name, ${spotifyUsers.displayName})`,
				href: sql`coalesce(excluded.href, ${spotifyUsers.href})`,
				uri: sql`coalesce(excluded.uri, ${spotifyUsers.uri})`,
				externalUrls: sql`excluded.external_urls`,
				followersTotal: sql`coalesce(excluded.followers_total, ${spotifyUsers.followersTotal})`,
				fetchedAt: sql`now()`,
				updatedAt: sql`now()`
			}
		});
}

/** Fetches /me and marks that row as the account this instance belongs to. */
export async function ingestMe(): Promise<PrivateUser> {
	const user = await fetchMe();

	await db.transaction(async (tx) => {
		// Exactly one row may carry is_me; clear any previous owner first so the
		// partial unique index can never be violated.
		await tx
			.update(spotifyUsers)
			.set({ isMe: false })
			.where(sql`${spotifyUsers.isMe} and ${spotifyUsers.id} <> ${user.id}`);

		await tx
			.insert(spotifyUsers)
			.values({
				id: user.id,
				displayName: user.display_name,
				href: user.href,
				uri: user.uri,
				externalUrls: user.external_urls ?? {},
				followersTotal: user.followers?.total ?? null,
				isMe: true,
				email: user.email ?? null,
				country: user.country ?? null,
				product: user.product ?? null,
				explicitFilterEnabled: user.explicit_content?.filter_enabled ?? null,
				explicitFilterLocked: user.explicit_content?.filter_locked ?? null,
				fetchedAt: new Date()
			})
			.onConflictDoUpdate({
				target: spotifyUsers.id,
				set: {
					displayName: sql`coalesce(excluded.display_name, ${spotifyUsers.displayName})`,
					href: sql`excluded.href`,
					uri: sql`excluded.uri`,
					externalUrls: sql`excluded.external_urls`,
					followersTotal: sql`excluded.followers_total`,
					isMe: true,
					email: sql`coalesce(excluded.email, ${spotifyUsers.email})`,
					country: sql`coalesce(excluded.country, ${spotifyUsers.country})`,
					product: sql`coalesce(excluded.product, ${spotifyUsers.product})`,
					explicitFilterEnabled: sql`excluded.explicit_filter_enabled`,
					explicitFilterLocked: sql`excluded.explicit_filter_locked`,
					fetchedAt: sql`now()`,
					updatedAt: sql`now()`
				}
			});
	});

	return user;
}

export async function getMe() {
	const [row] = await db.select().from(spotifyUsers).where(eq(spotifyUsers.isMe, true));
	return row ?? null;
}
