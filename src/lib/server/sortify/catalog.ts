import { sql } from 'drizzle-orm';
import { db, query } from '../db/index.ts';
import { sortifyPlaylistOverrides } from '../db/schema/index.ts';
import { iso, thumb } from '../entities/shared.ts';
import { bumpVersion } from './version.ts';

/**
 * The playlists Sortify shows, and which of them it sorts into.
 *
 * Every playlist in the account is listed, followed ones included, because any
 * of them can be gone through in the feed. Only playlists the user owns can be
 * *eligible*: the ones songs get sorted into, that count when deciding whether
 * a liked song is "sorted", and that suggestions may point at. Three kinds are
 * left out by default — a monthly playlist is a record of what was on repeat
 * back then, a Spotify-made one is not the user's own sorting, and one nothing
 * was added to in two years is a snapshot rather than a playlist being filled —
 * and any playlist can be switched in or out, which is stored as an override.
 */

export type Exclusion =
	| { kind: 'monthly'; label: string }
	| { kind: 'generated'; label: string }
	| { kind: 'inactive'; label: string; since: string };

export interface CatalogPlaylist {
	id: string;
	name: string;
	description: string;
	owned: boolean;
	owner: string;
	snapshot_id: string;
	total: number;
	/** About 300 px. */
	image?: string;
	/** When the newest item was added, as far as the mirror knows. */
	last_added_at?: string;
	/** Why it is left out by default, if it is. */
	exclusion?: Exclusion;
	/** The user's choice, where it differs from the default. */
	override?: boolean;
	/** Sorted into, suggested, and counted as "sorted". Owned playlists only. */
	eligible: boolean;
}

/** Nothing added for this long and a playlist is left out by default. */
const INACTIVE_AFTER_MS = 2 * 365 * 86_400_000;

const MONTHS = new Set([
	'januari', 'februari', 'mars', 'april', 'maj', 'juni', 'juli', 'augusti', 'september',
	'oktober', 'november', 'december', 'january', 'february', 'march', 'may', 'june', 'july',
	'august', 'october'
]);

const YEAR = /^(19|20)\d\d$/;

/** The name alone says it is a monthly or a Spotify-made playlist. */
export function exclusionByName(name: string): Exclusion | undefined {
	const n = name.trim().toLowerCase();
	// "Dreamy December - 2018"
	if (/^.+\s-\s(19|20)\d\d$/.test(n)) return { kind: 'monthly', label: 'Monthly playlist' };
	// "Oktober", "Oktober 2019"
	const parts = n.split(' ').filter(Boolean);
	if (
		parts[0] &&
		MONTHS.has(parts[0]) &&
		(parts.length === 1 || (parts.length === 2 && YEAR.test(parts[1] ?? '')))
	) {
		return { kind: 'monthly', label: 'Monthly playlist' };
	}
	if (
		/^your top songs (19|20)\d\d$/.test(n) ||
		/^my (19|20)\d\d playlist in a bottle$/.test(n) ||
		n === 'liked from radio' ||
		n === 'gillat från radio'
	) {
		return { kind: 'generated', label: 'Made by Spotify' };
	}
	return undefined;
}

const MONTH_YEAR = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

export function exclusionOf(name: string, lastAddedAt: string | null | undefined): Exclusion | undefined {
	const byName = exclusionByName(name);
	if (byName) return byName;
	if (lastAddedAt && Date.parse(lastAddedAt) < Date.now() - INACTIVE_AFTER_MS) {
		return {
			kind: 'inactive',
			label: `Nothing added since ${MONTH_YEAR.format(new Date(lastAddedAt))}`,
			since: lastAddedAt
		};
	}
	return undefined;
}

interface Row {
	id: string;
	name: string;
	description: string | null;
	owned: boolean;
	owner: string | null;
	snapshot_id: string;
	total: number;
	image: string | null;
	last_added_at: string | null;
	override: boolean | null;
}

/** Every playlist in the account, most recently added to first. */
export async function listPlaylists(): Promise<CatalogPlaylist[]> {
	const rows = await query<Row>(sql`
		select p.id, p.name, p.description, p.is_owned as owned,
		       coalesce(u.display_name, p.owner_id) as owner,
		       p.snapshot_id,
		       coalesce(p.total_tracks, 0)::int as total,
		       ${thumb('playlist_images', 'playlist_id', 'p.id')} as image,
		       ${iso('la.last_added')} as last_added_at,
		       o.eligible as override
		  from playlists p
		  left join spotify_users u on u.id = p.owner_id
		  left join lateral (
		    select max(pt.added_at) as last_added -- sql-lint: internal
		      from playlist_tracks pt where pt.playlist_id = p.id
		  ) la on true
		  left join sortify_playlist_overrides o on o.playlist_id = p.id
		 where p.removed_at is null
		 order by la.last_added desc nulls last, p.name
	`);
	return rows.map(toCatalog);
}

function toCatalog(r: Row): CatalogPlaylist {
	const exclusion = r.owned ? exclusionOf(r.name, r.last_added_at) : undefined;
	const override = r.override ?? undefined;
	return {
		id: r.id,
		name: r.name,
		description: r.description ?? '',
		owned: r.owned,
		owner: r.owner ?? '',
		snapshot_id: r.snapshot_id,
		total: r.total,
		image: r.image ?? undefined,
		last_added_at: r.last_added_at ?? undefined,
		exclusion,
		override,
		eligible: r.owned && (override ?? exclusion === undefined)
	};
}

export async function eligiblePlaylists(): Promise<CatalogPlaylist[]> {
	return (await listPlaylists()).filter((p) => p.eligible);
}

/**
 * Switches a playlist in or out. Stored only where it differs from the
 * default, so the default keeps applying to a playlist the user never touched
 * — and an override that matches the default is simply dropped.
 */
export async function setEligibility(playlistId: string, eligible: boolean): Promise<CatalogPlaylist | null> {
	const playlist = (await listPlaylists()).find((p) => p.id === playlistId);
	if (!playlist) return null;
	if (!playlist.owned && eligible) throw new Error('Only playlists you own can be sorted into.');

	const byDefault = playlist.owned && playlist.exclusion === undefined;
	if (eligible === byDefault) {
		await db.execute(sql`delete from sortify_playlist_overrides where playlist_id = ${playlistId}`);
	} else {
		await db
			.insert(sortifyPlaylistOverrides)
			.values({ playlistId, eligible })
			.onConflictDoUpdate({
				target: sortifyPlaylistOverrides.playlistId,
				set: { eligible, updatedAt: sql`now()` }
			});
	}
	bumpVersion();
	return { ...playlist, override: eligible === byDefault ? undefined : eligible, eligible };
}
