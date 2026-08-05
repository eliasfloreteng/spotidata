import {
	getCoverage,
	getLimiters,
	getTopGenres,
	getTotals,
	isChainQueued
} from '$lib/server/entities/enrichment.ts';
import { loadSettings } from '$lib/server/settings.ts';
import { isOAuthConfigured, readAuthState } from '$lib/server/musicbrainz/oauth.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const [coverage, totals, limiters, settings, queued, genres, mbAuth] = await Promise.all([
		getCoverage(),
		getTotals(),
		getLimiters(),
		loadSettings(),
		isChainQueued(),
		getTopGenres(),
		readAuthState()
	]);

	return {
		coverage,
		totals,
		limiters,
		genres,
		queued,
		enabled: settings['enrich.enabled'],
		stages: {
			audio: settings['enrich.audioFeatures'],
			artists: settings['enrich.artists'],
			albums: settings['enrich.albums']
		},
		oauth: {
			configured: isOAuthConfigured(),
			authorized: Boolean(mbAuth),
			scope: mbAuth?.scope ?? null,
			error: mbAuth?.lastRefreshError ?? null
		}
	};
};
