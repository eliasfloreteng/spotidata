import { sql } from 'drizzle-orm';

export type { ArtistRef } from '../../types.ts';

/**
 * Raw SQL hands timestamps back as strings (drizzle only maps them inside the
 * query builder), so every timestamptz is projected through this instead of
 * `::text` — `2024-01-05 13:22:11+00` is not a shape `new Date()` is required
 * to accept, whereas the ISO form is.
 */
export const iso = (expr: string) =>
	sql.raw(`to_char(${expr} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`);

/**
 * Correlated subquery for an entity's largest image.
 *
 * Ordering is by width rather than by `position`: Spotify emits images
 * largest-first and the ingest preserves that order, so position 0 is the
 * *biggest*. Ordering on the dimension itself survives either convention.
 * All three arguments are compile-time literals, never user input.
 */
export const cover = (tbl: string, fk: string, ref: string) =>
	sql.raw(`(select i.url from ${tbl} i where i.${fk} = ${ref}
	           order by coalesce(i.width, 0) desc limit 1)`);

/** Smallest image at least 200px wide — the right size for a list row. */
export const thumb = (tbl: string, fk: string, ref: string) =>
	sql.raw(`(select i.url from ${tbl} i where i.${fk} = ${ref}
	           order by (coalesce(i.width, 0) < 200), coalesce(i.width, 0) limit 1)`);

/** `[{id,name}]` for the artists credited on one Spotify track, in order. */
export const trackArtistsJson = (ref: string) =>
	sql.raw(`coalesce((
		select jsonb_agg(jsonb_build_object('id', ar.id, 'name', ar.name) order by ta.position)
		  from track_artists ta join artists ar on ar.id = ta.artist_id
		 where ta.track_id = ${ref}
	), '[]'::jsonb)`);

export const PAGE_SIZE = 100;
export const INDEX_PAGE_SIZE = 60;

/** Clamps a `?page=` value to a sane 1-based integer. */
export function pageParam(url: URL, param = 'page'): number {
	const raw = Number.parseInt(url.searchParams.get(param) ?? '1', 10);
	return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 100_000) : 1;
}

/**
 * Resolves `?sort=`/`?dir=` against a whitelist. The ORDER BY fragment is
 * looked up, never built from the query string, so `sql.raw` stays safe.
 */
export function sortParam<K extends string>(
	url: URL,
	allowed: Record<K, string>,
	fallback: K,
	defaultDir: 'asc' | 'desc' = 'desc'
): { key: K; dir: 'asc' | 'desc'; clause: ReturnType<typeof sql.raw> } {
	const raw = url.searchParams.get('sort') as K | null;
	const key = raw && raw in allowed ? raw : fallback;
	const dir = url.searchParams.get('dir') === 'asc' ? 'asc' : url.searchParams.get('dir') === 'desc' ? 'desc' : defaultDir;
	return { key, dir, clause: sql.raw(`${allowed[key]} ${dir} nulls last`) };
}

export function searchParam(url: URL): string {
	return (url.searchParams.get('q') ?? '').trim().slice(0, 120);
}

export interface Paged<T> {
	rows: T[];
	total: number;
	page: number;
	pageSize: number;
	pages: number;
}

export function paged<T extends { total?: number }>(
	rows: T[],
	page: number,
	pageSize: number
): Paged<T> {
	const total = rows[0]?.total ?? 0;
	return { rows, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}
