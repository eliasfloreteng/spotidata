import { redirect } from '@sveltejs/kit';
import { revoke } from '$lib/server/musicbrainz/oauth.ts';
import type { RequestHandler } from './$types';

/**
 * Drops the grant. Enrichment is unaffected — it never used it: the
 * MusicBrainz web service is open to anonymous clients.
 */
export const POST: RequestHandler = async () => {
	await revoke();
	redirect(302, '/enrich');
};
