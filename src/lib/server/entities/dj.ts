import { sql, type SQL } from 'drizzle-orm';
import { anyOf, notIn } from '../db/arrays.ts';
import { query } from '../db/index.ts';
import { movesFrom, type KeyMode, type KeyMove } from '../../utils/music.ts';
import { like, thumb, total, type ArtistRef } from './shared.ts';

/**
 * Finding the next record to play.
 *
 * The pool is every library recording rbxport measured a tempo and a key for,
 * from Deezer's 30-second preview (`queue/tasks/analyse.ts`) — the whole
 * library but the few recordings Deezer has no preview of, rather than the
 * half AcousticBrainz covered before it closed in 2022. A track outside the
 * pool can still sit in a set, it just cannot be matched against, so it shows
 * its numbers as unknown. AcousticBrainz still lends its mood classifiers to
 * the "feel" part of the score where it has them.
 *
 * Which keys may follow which is decided in TypeScript (`movesFrom` in
 * utils/music.ts) and handed to Postgres as a table, so the suggestion list and
 * the set's transition labels read the same definition. Tempo folding is SQL
 * only, in `TEMPO_FOLD`, for the same reason in the other direction.
 */

/**
 * One row per library recording with a tempo and key rbxport measured.
 *
 * Read through `track_enrichment` like every other enrichment consumer, so
 * "measured" means what it means on the track page. Two things are left out
 * on purpose and fetched for the rows that survive the filters instead: the
 * display columns, and the genres (`genresOf`), whose per-recording lookup is
 * most of the cost of reading all 5k rows — and the selective parts of every
 * query here (a key, a tempo window) run before anything needs them.
 */
const POOL = sql`
	select lc.canonical_track_id as id,
	       te.rbx_bpm as bpm,
	       te.rbx_camelot as code,
	       te.rbx_bpm_confidence as bpm_confidence,
	       te.recording_mbid as mbid,
	       te.danceable, te.electronic, te.aggressive, te.happy, te.relaxed,
	       lc.liked,
	       lc.first_added_at,
	       coalesce(cps.plays, 0) as plays
	  from library_canonical lc
	  join spotidata.track_enrichment te on te.canonical_track_id = lc.canonical_track_id
	  left join canonical_play_stats cps on cps.canonical_track_id = lc.canonical_track_id
	 where te.rbx_bpm is not null and te.rbx_camelot is not null`;

/** A pool row's MusicBrainz genres, best-voted first — the view's own definition. */
const genresOf = (alias: string) =>
	sql.raw(`spotidata.mb_genre_list('recording', ${alias}.mbid)`);

/** The pool row carries a genre: an index probe, not a genre list per row. */
const hasGenre = (alias: string, genre: string) => sql`exists (
	select 1 from spotidata.track_genres tg
	 where tg.canonical_track_id = ${sql.raw(alias)}.id and tg.genre = ${genre}
)`;

/**
 * The pitch needed to match `next` to `playing`, with octaves folded.
 *
 * A tempo can read an octave out — rbxport measures within 70–180 BPM, so an
 * 87 BPM record and a 174 BPM one look alike to it in thirty seconds — and a
 * DJ beat-matches across that anyway, so the nearest of ½×, 1× and 2× wins. A lateral, because `pct` is wanted alongside
 * the factor that produced it.
 */
const TEMPO_FOLD = (playing: SQL, next: SQL) => sql`lateral (
	select f.factor, (${next} * f.factor / ${playing} - 1) * 100 as pct
	  from (values (1::real), (2::real), (0.5::real)) as f(factor)
	 order by abs(${next} * f.factor / ${playing} - 1), f.factor = 1 desc
	 limit 1
)`;

/** Shared genres over all genres, or null when either side has none. */
const GENRE_OVERLAP = (a: SQL, b: SQL) => sql`(
	case when ${a} is null or ${b} is null then null
	     else (select count(distinct g)::real from unnest(${a}) g where g = any(${b}))
	        / nullif((select count(distinct g) from unnest(${a} || ${b}) g), 0)
	end)`;

/**
 * One song, however many recordings of it the library holds: the radio edit,
 * the extended mix and the 2015 remaster share it, so the suggestions offer the
 * song once — and never one already in the set. Same key as the Sortify
 * export, `spotidata.song_title_key` under the primary artist, falling back to
 * the recording when nothing but qualifiers is left of the title.
 */
const SONG = (alias: string) =>
	sql.raw(
		`(coalesce(nullif(spotidata.song_title_key(${alias}.title), ''), ${alias}.id) || '|' || coalesce(${alias}.primary_artist_id, ''))`
	);

/** Display columns for a recording `ct`, the same set the library list shows. */
const DISPLAY = sql`
	ct.title,
	ct.duration_ms as "durationMs",
	ct.representative_track_id as "representativeTrackId",
	${thumb('album_images', 'album_id', 'ct.primary_album_id')} as cover,
	coalesce((
	  select jsonb_agg(jsonb_build_object('id', ar.id, 'name', ar.name) order by cta.position)
	    from canonical_track_artists cta
	    join artists ar on ar.id = cta.artist_id
	   where cta.canonical_track_id = ct.id and cta.on_representative
	), '[]'::jsonb) as artists`;

interface Display {
	canonicalTrackId: string;
	title: string;
	durationMs: number;
	representativeTrackId: string;
	cover: string | null;
	artists: ArtistRef[];
}

export interface DjTrack extends Display {
	bpm: number;
	camelot: string;
	/** rbxport's 0–1 confidence in the tempo; low means it may be off. */
	bpmConfidence: number | null;
	genres: string[] | null;
	/** AcousticBrainz's P(danceable), 0–1. */
	danceable: number | null;
	liked: boolean;
	plays: number;
}

// ------------------------------------------------------------------ browse

/**
 * Whitelisted ORDER BY columns. `key` reads the wheel in order — 1A, 1B, 2A … —
 * which a plain sort on the code would scramble into 10A, 11A, 12A, 1A.
 */
export const DJ_SORTS = {
	bpm: ['p.bpm'],
	key: ["rtrim(p.code, 'AB')::int", 'p.code'],
	plays: ['p.plays'],
	added: ['p.first_added_at'],
	dance: ['p.danceable']
} as const;
export type DjSort = keyof typeof DJ_SORTS;

export const isDjSort = (v: string): v is DjSort => v in DJ_SORTS;

export interface BrowseFilters {
	bpmMin: number | null;
	bpmMax: number | null;
	camelot: string | null;
	genre: string | null;
	q: string;
}

/** The browse filters as predicates, minus whichever dimension is being counted. */
function browseParts(f: BrowseFilters, skip?: 'bpm' | 'key'): SQL[] {
	const parts: SQL[] = [];
	if (skip !== 'bpm' && f.bpmMin != null) parts.push(sql`p.bpm >= ${f.bpmMin}`);
	if (skip !== 'bpm' && f.bpmMax != null) parts.push(sql`p.bpm < ${f.bpmMax}`);
	if (skip !== 'key' && f.camelot) parts.push(sql`p.code = ${f.camelot}`);
	if (f.genre) parts.push(hasGenre('p', f.genre));
	if (f.q) {
		parts.push(sql`exists (
			select 1 from canonical_tracks c
			  left join artists a on a.id = c.primary_artist_id
			 where c.id = p.id and (${like(sql`c.title`, f.q)} or ${like(sql`a.name`, f.q)})
		)`);
	}
	return parts;
}

const allOf = (parts: SQL[]) => (parts.length ? sql.join(parts, sql` and `) : sql`true`);

export async function browseTracks(opts: {
	filters: BrowseFilters;
	sort: DjSort;
	dir: 'asc' | 'desc';
	limit: number;
	offset: number;
}): Promise<(DjTrack & { total: number })[]> {
	// Every sort ends on tempo then id, so a page boundary never reshuffles.
	const order = sql.raw(
		[...DJ_SORTS[opts.sort].map((c) => `${c} ${opts.dir} nulls last`), 'p.bpm', 'p.id'].join(', ')
	);
	return query(sql`
		with p as (${POOL})
		select ${total},
		       p.id as "canonicalTrackId",
		       p.bpm, p.code as camelot, p.bpm_confidence as "bpmConfidence", ${genresOf('p')} as genres,
		       p.danceable, p.liked, p.plays,
		       ${DISPLAY}
		  from p
		  join canonical_tracks ct on ct.id = p.id
		 where ${allOf(browseParts(opts.filters))}
		 order by ${order}
		 limit ${opts.limit} offset ${opts.offset}
	`);
}

export interface PoolShape {
	/** Recordings in the library with a tempo and key — the pool. */
	pool: number;
	library: number;
	/** Per Camelot code, under every filter but the key. */
	keys: { code: string; tracks: number }[];
	/** Per 5-BPM bin, under every filter but the tempo. `bin` is its lower edge. */
	tempo: { bin: number; tracks: number }[];
	/** The pool's genres, most common first, for the genre picker. */
	genres: { genre: string; tracks: number }[];
}

/** Tempo bins: 5 BPM wide, with the long tails folded into the end bins. */
export const BIN = 5;
export const BIN_MIN = 60;
export const BIN_MAX = 200;

/**
 * The wheel, the tempo strip and the totals in one pass over the pool.
 *
 * Each chart counts under every filter but its own — the wheel ignores the key
 * filter, the strip the tempo one — so picking 8A still shows what else is at
 * this tempo, and the count beside each choice is what clicking it would give.
 * GROUPING SETS with a FILTER per aggregate is that, without three scans.
 */
export async function poolShape(filters: BrowseFilters): Promise<PoolShape> {
	const [shape, genres, library] = await Promise.all([
		query<{ code: string | null; bin: number | null; byKey: number; byTempo: number; pool: number }>(sql`
			with p as (
			  select p.*, greatest(${BIN_MIN}, least(${BIN_MAX - BIN}, floor(p.bpm / ${BIN}) * ${BIN}))::int as bin
			    from (${POOL}) p
			)
			select p.code, p.bin,
			       count(*) filter (where ${allOf(browseParts(filters, 'key'))})::int as "byKey",
			       count(*) filter (where ${allOf(browseParts(filters, 'bpm'))})::int as "byTempo",
			       count(*)::int as pool
			  from p
			 group by grouping sets ((p.code), (p.bin), ())
		`),
		query<{ genre: string; tracks: number }>(sql`
			with p as (${POOL})
			select tg.genre, count(distinct p.id)::int as tracks
			  from p
			  join spotidata.track_genres tg on tg.canonical_track_id = p.id
			 group by tg.genre
			having count(distinct p.id) >= 3
			 order by tracks desc, tg.genre
			 limit 300
		`),
		query<{ n: number }>(sql`select count(*)::int as n from library_canonical`)
	]);
	return {
		pool: shape.find((r) => r.code == null && r.bin == null)?.pool ?? 0,
		library: library[0]?.n ?? 0,
		keys: shape
			.filter((r) => r.code != null)
			.map((r) => ({ code: r.code as string, tracks: r.byKey })),
		tempo: shape
			.filter((r) => r.bin != null)
			.map((r) => ({ bin: r.bin as number, tracks: r.byTempo }))
			.sort((a, b) => a.bin - b.bin),
		genres
	};
}

// --------------------------------------------------------------------- set

export interface SetTrack extends Display {
	position: number;
	bpm: number | null;
	camelot: string | null;
	genres: string[] | null;
	/** Pitch from the previous track to this one, octaves folded; null for the first. */
	tempoPct: number | null;
	tempoFactor: number | null;
}

/**
 * The tracks of a set, in the order given, with the tempo step into each.
 *
 * Ids that no longer resolve (a canonical regrouping, a hand-edited URL) drop
 * out rather than failing the page; the key move is labelled by the caller from
 * the two codes, because which moves exist is TypeScript's to say.
 */
export async function setTracks(ids: string[]): Promise<SetTrack[]> {
	if (ids.length === 0) return [];
	return query<SetTrack>(sql`
		with s as (
		  select s.id, s.ord::int as ord
		    from jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) with ordinality as s(id, ord)
		),
		r as (
		  select s.ord, ct.id, te.rbx_bpm as bpm, te.rbx_camelot as code, te.genres,
		         lag(te.rbx_bpm) over (order by s.ord) as prev_bpm
		    from s
		    join canonical_tracks ct on ct.id = s.id
		    left join spotidata.track_enrichment te on te.canonical_track_id = ct.id
		)
		select r.ord as position,
		       r.id as "canonicalTrackId",
		       r.bpm, r.code as camelot, r.genres,
		       t.pct as "tempoPct",
		       t.factor as "tempoFactor",
		       ${DISPLAY}
		  from r
		  join canonical_tracks ct on ct.id = r.id
		  left join ${TEMPO_FOLD(sql`r.prev_bpm`, sql`r.bpm`)} t on r.prev_bpm is not null and r.bpm is not null
		 order by r.ord
	`);
}

// -------------------------------------------------------------------- next

export interface NextTrack extends DjTrack {
	move: KeyMove | null;
	tempoPct: number;
	tempoFactor: number;
	/** Jaccard over MusicBrainz genres; null when either side has none. */
	genreOverlap: number | null;
	sharedGenres: string[];
	/** 0–1, the blend of everything below, for ranking and a bar. */
	score: number;
}

export interface NextOptions {
	tolerance: number;
	keyMode: KeyMode;
	genre: string | null;
	/** A search ignores tempo and key, and only ranks by them. */
	q: string;
	exclude: string[];
	limit: number;
}

/**
 * What could follow `seed`, best first.
 *
 * The score weighs, in order: how safe the key move is, how little pitching it
 * takes, how much the two share genres, how alike they feel to AcousticBrainz's
 * classifiers, and — lightly — whether it is a record you actually play. The
 * key and the tempo are gates as well as weights; the rest only rank. The
 * classifiers are AcousticBrainz's, so a recording it never heard counts as
 * neutral there.
 *
 * A folded tempo (½× or 2×) is a real mix but a riskier one, so it gives up a
 * little of its tempo score.
 */
export async function nextTracks(seed: string, opts: NextOptions): Promise<NextTrack[]> {
	const [s] = await query<{ code: string }>(sql`
		with p as (${POOL}) select p.code from p where p.id = ${seed}
	`);
	if (!s) return [];

	const searching = opts.q !== '';
	const moves = movesFrom(s.code, searching ? 'any' : opts.keyMode);
	const tol = opts.tolerance;

	const gates: SQL[] = [sql`c.id ${notIn(opts.exclude)}`];
	if (!searching) gates.push(sql`abs(t.pct) <= ${tol}`);
	if (opts.genre) gates.push(hasGenre('c', opts.genre));
	if (searching) {
		gates.push(sql`exists (
			select 1 from canonical_tracks x
			  left join artists a on a.id = x.primary_artist_id
			 where x.id = c.id and (${like(sql`x.title`, opts.q)} or ${like(sql`a.name`, opts.q)})
		)`);
	}

	// Gate first, then look genres up for what is left: a harmonic ±6% window
	// is a few hundred rows of five thousand.
	return query<NextTrack>(sql`
		with p as materialized (${POOL}),
		seed as materialized (select p.*, ${genresOf('p')} as genres from p where p.id = ${seed}),
		m as (
		  select * from jsonb_to_recordset(${JSON.stringify(moves)}::jsonb)
		    as m(code text, move text, weight real)
		),
		gated as materialized (
		  select c.*, ${genresOf('c')} as genres, m.move, m.weight as key_score, t.pct, t.factor
		    from p c
		    cross join seed
		    join m on m.code = c.code
		    cross join ${TEMPO_FOLD(sql`seed.bpm`, sql`c.bpm`)} t
		   where ${sql.join(gates, sql` and `)}
		),
		scored as (
		  select c.*,
		         ${GENRE_OVERLAP(sql`c.genres`, sql`seed.genres`)} as overlap,
		         array(select g from unnest(c.genres) g where g = any(seed.genres)) as shared,
		         1 - (abs(coalesce(c.danceable, 0.5) - coalesce(seed.danceable, 0.5))
		            + abs(coalesce(c.electronic, 0.5) - coalesce(seed.electronic, 0.5))
		            + abs(coalesce(c.aggressive, 0.5) - coalesce(seed.aggressive, 0.5))
		            + abs(coalesce(c.happy, 0.5) - coalesce(seed.happy, 0.5))
		            + abs(coalesce(c.relaxed, 0.5) - coalesce(seed.relaxed, 0.5))) / 5 as feel,
		         greatest(0, 1 - abs(c.pct) / ${tol}) * case when c.factor = 1 then 1 else 0.8 end as tempo_score
		    from gated c
		    cross join seed
		),
		ranked as (
		  select distinct on (${SONG('ct')})
		         sc.*, ${SONG('ct')} as song,
		         (0.40 * sc.key_score
		        + 0.25 * sc.tempo_score
		        + 0.20 * least(1, coalesce(sc.overlap, 0.15) * 2)
		        + 0.10 * sc.feel
		        + 0.05 * least(1, ln(1 + sc.plays) / ln(50)))::real as score
		    from scored sc
		    join canonical_tracks ct on ct.id = sc.id
		   where ${SONG('ct')} not in (
		           select ${SONG('x')} from canonical_tracks x where x.id = ${anyOf(opts.exclude)}
		         )
		   order by ${SONG('ct')}, score desc, sc.id
		)
		select r.id as "canonicalTrackId",
		       r.bpm, r.code as camelot, r.bpm_confidence as "bpmConfidence", r.genres,
		       r.danceable, r.liked, r.plays,
		       r.move, r.pct as "tempoPct", r.factor as "tempoFactor",
		       r.overlap as "genreOverlap", r.shared as "sharedGenres",
		       r.score,
		       ${DISPLAY}
		  from ranked r
		  join canonical_tracks ct on ct.id = r.id
		 order by r.score desc, r.id
		 limit ${opts.limit}
	`);
}
