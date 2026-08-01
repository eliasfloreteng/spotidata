import { redirect } from '@sveltejs/kit';
import { logout } from '$lib/server/spotify/auth.ts';
import type { RequestHandler } from './$types';

/**
 * Clears the stored grant only. All ingested data survives — re-authorizing
 * restores full function without a resync.
 */
export const POST: RequestHandler = async () => {
	await logout();
	redirect(302, '/settings');
};
