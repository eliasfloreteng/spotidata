import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db/index.ts';
import { readAuthState } from '$lib/server/spotify/auth.ts';
import { getMe } from '$lib/server/ingest/upsert-users.ts';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
	const [auth, me, active] = await Promise.all([
		readAuthState(),
		getMe(),
		db.execute<{ id: number; status: string }>(sql`
			select id, status from sync_runs
			 where status in ('queued','running','paused_rate_limited','paused_auth') limit 1
		`)
	]);

	const daysLeft = auth?.refreshExpiresAt
		? Math.floor((new Date(auth.refreshExpiresAt).getTime() - Date.now()) / 86_400_000)
		: null;

	return {
		linkScheme: locals.settings['links.scheme'],
		timezone: locals.settings['ui.timezone'],
		me: me ? { id: me.id, displayName: me.displayName } : null,
		auth: {
			authorized: Boolean(auth) && !auth?.needsReauth,
			needsReauth: auth?.needsReauth ?? false,
			daysLeft
		},
		activeSync: active.rows[0] ?? null
	};
};
