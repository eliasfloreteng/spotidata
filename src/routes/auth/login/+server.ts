import { redirect } from '@sveltejs/kit';
import { createAuthorizeUrl } from '$lib/server/spotify/auth.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	redirect(302, await createAuthorizeUrl());
};
