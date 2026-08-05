import { sql, type SQL } from 'drizzle-orm';
import { filterParams, GENRE_FILTERS, type ActiveFilters } from '../../filters.ts';
import { anyOf } from '../db/arrays.ts';
import { query } from '../db/index.ts';
import {
	andAll,
	clauseFor,
	EXPLICIT_CLAUSES,
	iso,
	like,
	PLAYED_CLAUSES,
	searchParam,
	sortParam,
	thumb,
	total,
	type ArtistRef
} from './shared.ts';

/**
 * The genre browser: pick genres, read the tracks they contain, hand back the
 * links.
 *
 * Everything reads `spotidata.track_genres` (db/sql/post/100_genres.sql),
 * which is the union of MusicBrainz recording tags and Spotify artist genres.
 * The two disagree in vocabulary as much as in coverage — MusicBrainz says
 * "synth-pop", Spotify says "swedish pop" — so the source is a filter rather
 * than something to reconcile, and the selection carries it.
 */

/** Genres per selection, and per track row. Both are UI limits, not truths. */
const MAX_GENRES = 40;
const MAX_ROW_GENRES = 8;

/**
 * The ceiling on one copy. Spotify's own playlist limit is 10,000 tracks, but
 * a paste of thousands of links is not something the client survives — the
 * page copies in batches of 100 and this is the backstop on the whole set.
 */
export const MAX_LINKS = 2000;

export const GENRE_SORTS = {
	added: 'lc.first_added_at',
	name: 'ct.title',
	artist: 'pa.name',
	popularity: 'ct.max_popularity',
	duration: 'ct.duration_ms',
	released: 'ct.earliest_release_date',
	plays: 'coalesce(cps.plays, 0)',
	listened: 'coalesce(cps.ms_played, 0)'
} as const;
export type GenreSort = keyof typeof GENRE_SORTS;

/** `''` is both sources at once, which is what the union view already is. */
const SOURCE_CLAUSES: Record<string, SQL> = {
	recording: sql`tg.source = 'recording'`,
	artist: sql`tg.source = 'artist'`
};

/**
 * Everything the page and the links endpoint both need, parsed once.
 *
 * The two must agree exactly: what you copy is what the table in front of you
 * shows, in the same order, or the playlist you paste is not the one you were
 * looking at.
 */
export interface GenreSelection {
	genres: string[];
	q: string;
	filters: ActiveFilters;
	sort: GenreSort;
	dir: 'asc' | 'desc';
	order: SQL;
}

export function genreSelection(url: URL): GenreSelection {
	const sort = sortParam(url, GENRE_SORTS, 'added', 'desc');
	return {
		// Repeated `?g=` rather than one delimited value: genre names contain
		// commas ("drum and bass, jungle" is two, "r&b, funk & soul" is one) and
		// the browser's own encoding is the only escaping that never argues.
		genres: [...new Set(url.searchParams.getAll('g').map((g) => g.trim()).filter(Boolean))].slice(
			0,
			MAX_GENRES
		),
		q: searchParam(url),
		filters: filterParams(url, GENRE_FILTERS),
		sort: sort.key,
		dir: sort.dir,
		order: sort.clause
	};
}

/** The genre predicate, which is the only part of the WHERE the two modes differ on. */
function genreMatch(sel: GenreSelection): SQL {
	const source = clauseFor(sel.filters.src, SOURCE_CLAUSES);
	const scoped = source ? sql` and ${source}` : sql``;
	const wanted = sql`tg.canonical_track_id = ct.id and tg.genre = ${anyOf(sel.genres)}${scoped}`;

	// "All" is a count rather than a chain of EXISTS: one index scan per track
	// either way, and it stays one clause however many genres are selected.
	return sel.filters.match === 'all'
		? sql`(select count(distinct tg.genre) from spotidata.track_genres tg
		        where ${wanted}) = ${sel.genres.length}`
		: sql`exists (select 1 from spotidata.track_genres tg where ${wanted})`;
}

function whereFor(sel: GenreSelection): SQL {
	const search = sel.q
		? sql` and (${like(sql`ct.title`, sel.q)} or ${like(sql`pa.name`, sel.q)} or ${like(sql`al.name`, sel.q)})`
		: sql``;
	return sql`${genreMatch(sel)}${search}${andAll([
		clauseFor(sel.filters.explicit, EXPLICIT_CLAUSES(sql`ct.explicit`)),
		clauseFor(sel.filters.played, PLAYED_CLAUSES)
	])}`;
}

/**
 * The from-list every genre query shares. `pa` and `al` are joined even when
 * nothing sorts or searches on them, because the row renders them.
 */
const GENRE_FROM = sql`
	  from library_canonical lc
	  join canonical_tracks ct on ct.id = lc.canonical_track_id
	  left join canonical_play_stats cps on cps.canonical_track_id = lc.canonical_track_id
	  left join albums al on al.id = ct.primary_album_id
	  left join artists pa on pa.id = ct.primary_artist_id`;

export interface GenreTrackRow {
	total: number;
	canonicalTrackId: string;
	/** The copy the Spotify link points at — the id that ends up in the playlist. */
	trackId: string;
	title: string;
	durationMs: number;
	popularity: number | null;
	explicit: boolean;
	liked: boolean;
	firstAddedAt: string;
	albumId: string | null;
	albumName: string | null;
	cover: string | null;
	artists: ArtistRef[];
	/** The track's own genres, the selected ones first. */
	genres: string[];
	plays: number;
	msPlayed: number;
}

export async function genreTracks(
	sel: GenreSelection,
	opts: { limit: number; offset: number }
): Promise<GenreTrackRow[]> {
	if (sel.genres.length === 0) return [];
	return query<GenreTrackRow>(sql`
		select ${total},
		       ct.id                      as "canonicalTrackId",
		       ct.representative_track_id as "trackId",
		       ct.title,
		       ct.duration_ms             as "durationMs",
		       ct.max_popularity          as popularity,
		       ct.explicit,
		       lc.liked,
		       ${iso('lc.first_added_at')} as "firstAddedAt",
		       al.id                      as "albumId",
		       al.name                    as "albumName",
		       ${thumb('album_images', 'album_id', 'al.id')} as cover,
		       coalesce((
		         select jsonb_agg(jsonb_build_object('id', ar.id, 'name', ar.name)
		                          order by cta.position)
		           from canonical_track_artists cta
		           join artists ar on ar.id = cta.artist_id
		          where cta.canonical_track_id = ct.id and cta.on_representative
		       ), '[]'::jsonb)            as artists,
		       -- Why this row is here, in the order that answers it: the genres you
		       -- picked first, then whatever else it carries, best-voted first.
		       coalesce((
		         select array_agg(g.genre) from (
		           select tg.genre
		             from spotidata.track_genres tg
		            where tg.canonical_track_id = ct.id
		            group by tg.genre
		            order by (tg.genre = ${anyOf(sel.genres)}) desc, max(tg.votes) desc, tg.genre
		            limit ${MAX_ROW_GENRES}
		         ) g
		       ), '{}'::text[])           as genres,
		       coalesce(cps.plays, 0)     as plays,
		       coalesce(cps.ms_played, 0)::bigint as "msPlayed"
		       ${GENRE_FROM}
		 where ${whereFor(sel)}
		 order by ${sel.order}, ct.id
		 limit ${opts.limit} offset ${opts.offset}
	`);
}

/**
 * The same rows, as bare Spotify track ids, in the same order — the paste
 * order has to be the reading order.
 */
export async function genreTrackIds(sel: GenreSelection, limit = MAX_LINKS): Promise<string[]> {
	if (sel.genres.length === 0) return [];
	const rows = await query<{ trackId: string }>(sql`
		select ct.representative_track_id as "trackId"
		       ${GENRE_FROM}
		 where ${whereFor(sel)}
		 order by ${sel.order}, ct.id
		 limit ${limit}
	`);
	return rows.map((r) => r.trackId);
}

export interface GenreOption {
	genre: string;
	tracks: number;
	/** Which catalogs put this genre on a track: 'recording', 'artist', or both. */
	sources: string[];
}

/**
 * The whole vocabulary that describes something in the library, most-used
 * first — not a top-N, because a selected genre missing from the list would
 * leave a filter the UI cannot show or clear. 765 rows on this account.
 */
export async function genreVocabulary(source: string): Promise<GenreOption[]> {
	const where = clauseFor(source, SOURCE_CLAUSES);
	return query<GenreOption>(sql`
		select tg.genre,
		       count(distinct tg.canonical_track_id)::int as tracks,
		       array_agg(distinct tg.source)              as sources
		  from spotidata.track_genres tg
		  join library_canonical lc on lc.canonical_track_id = tg.canonical_track_id
		 where true${where ? sql` and ${where}` : sql``}
		 group by tg.genre
		 order by tracks desc, tg.genre
	`);
}
