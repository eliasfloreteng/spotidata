import { error, redirect } from '@sveltejs/kit';
import { consumeState, exchangeCode } from '$lib/server/musicbrainz/oauth.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	const denied = url.searchParams.get('error');
	if (denied) error(400, `MusicBrainz authorization was denied: ${denied}`);

	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	if (!code || !state) error(400, 'Missing code or state in callback');

	// Single-use CSRF token; a replayed callback must not mint a new grant.
	if (!(await consumeState(state))) {
		error(400, 'Invalid or expired state — start again from /auth/musicbrainz/login');
	}

	await exchangeCode(code);
	redirect(302, '/enrich?authorized=1');
};
