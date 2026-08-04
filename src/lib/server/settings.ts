import { sql } from 'drizzle-orm';
import { db } from './db/index.ts';
import { settings as settingsTable } from './db/schema/index.ts';

export type LinkScheme = 'uri' | 'web';

export interface Settings {
	/** `uri` opens the desktop app via spotify:, `web` uses open.spotify.com. */
	'links.scheme': LinkScheme;
	/** Every date bucket in every chart is computed AT TIME ZONE this value. */
	'ui.timezone': string;
	'ui.weekStart': 'monday' | 'sunday';
	/** Steady-state request budget. The first full sync deliberately runs lower. */
	'ratelimit.targetRpm': number;
	'sync.storeRawPayloads': boolean;
	'sync.hydrateAlbumTracks': boolean;
	/**
	 * Fetch the tracks the listening history names but the catalog has never
	 * seen. On a first import that is a few hundred requests; without it, plays
	 * of never-saved music stay as bare names.
	 */
	'history.resolvePlayedTracks': boolean;
	/** Poll /me/player/recently-played on a cron between syncs. */
	'history.pollRecentlyPlayed': boolean;
}

export const DEFAULT_SETTINGS: Settings = {
	'links.scheme': 'uri',
	'ui.timezone': 'Europe/Stockholm',
	'ui.weekStart': 'monday',
	'ratelimit.targetRpm': 150,
	'sync.storeRawPayloads': true,
	'sync.hydrateAlbumTracks': true,
	'history.resolvePlayedTracks': true,
	'history.pollRecentlyPlayed': true
};

export async function loadSettings(): Promise<Settings> {
	const rows = await db.select().from(settingsTable);
	const out = { ...DEFAULT_SETTINGS };
	for (const row of rows) {
		if (row.key in out) {
			(out as Record<string, unknown>)[row.key] = row.value;
		}
	}
	return out;
}

export async function setSetting<K extends keyof Settings>(
	key: K,
	value: Settings[K]
): Promise<void> {
	await db
		.insert(settingsTable)
		.values({ key, value })
		.onConflictDoUpdate({
			target: settingsTable.key,
			set: { value: sql`excluded.value`, updatedAt: sql`now()` }
		});
}

/** Seeds any missing key with its default. Idempotent; run after migrate. */
export async function seedSettings(): Promise<void> {
	const values = Object.entries(DEFAULT_SETTINGS).map(([key, value]) => ({ key, value }));
	await db.insert(settingsTable).values(values).onConflictDoNothing();
}
