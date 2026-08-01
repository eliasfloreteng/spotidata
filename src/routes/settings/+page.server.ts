import { fail } from '@sveltejs/kit';
import { readAuthState } from '$lib/server/spotify/auth.ts';
import { getMe } from '$lib/server/ingest/upsert-users.ts';
import { loadSettings, setSetting, type LinkScheme } from '$lib/server/settings.ts';
import { readLimiter, setTargetRpm } from '$lib/server/spotify/ratelimit.ts';
import { invalidateSettingsCache } from '../../hooks.server.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const [auth, me, settings, limiter] = await Promise.all([
		readAuthState(),
		getMe(),
		loadSettings(),
		readLimiter()
	]);

	const refreshExpiresAt = auth?.refreshExpiresAt ? new Date(auth.refreshExpiresAt) : null;

	return {
		authorized: Boolean(auth) && !auth?.needsReauth,
		needsReauth: auth?.needsReauth ?? false,
		authorizedAt: auth?.authorizedAt ? new Date(auth.authorizedAt).toISOString() : null,
		refreshExpiresAt: refreshExpiresAt?.toISOString() ?? null,
		daysLeft: refreshExpiresAt
			? Math.floor((refreshExpiresAt.getTime() - Date.now()) / 86_400_000)
			: null,
		scope: auth?.scope ?? null,
		me: me
			? { id: me.id, displayName: me.displayName, country: me.country, product: me.product }
			: null,
		settings,
		limiter
	};
};

export const actions: Actions = {
	save: async ({ request }) => {
		const form = await request.formData();

		const scheme = form.get('linkScheme');
		if (scheme === 'uri' || scheme === 'web') {
			await setSetting('links.scheme', scheme as LinkScheme);
		}

		const tz = form.get('timezone');
		if (typeof tz === 'string' && tz.length > 0) {
			// Validate before storing: a bad zone makes every AT TIME ZONE in the
			// stats layer throw, which would take down the whole dashboard.
			try {
				new Intl.DateTimeFormat('en', { timeZone: tz });
				await setSetting('ui.timezone', tz);
			} catch {
				return fail(400, { error: `Unknown timezone "${tz}"` });
			}
		}

		const weekStart = form.get('weekStart');
		if (weekStart === 'monday' || weekStart === 'sunday') {
			await setSetting('ui.weekStart', weekStart);
		}

		const rpm = Number(form.get('targetRpm'));
		if (Number.isFinite(rpm) && rpm >= 10 && rpm <= 600) {
			await setSetting('ratelimit.targetRpm', rpm);
			await setTargetRpm(rpm);
		}

		await setSetting('sync.storeRawPayloads', form.get('storeRaw') === 'on');

		// The hooks cache is 5s; drop it so the change is visible immediately.
		invalidateSettingsCache();
		return { saved: true };
	}
};
