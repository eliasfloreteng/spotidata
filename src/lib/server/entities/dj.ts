import { sql, type SQL } from 'drizzle-orm';
import { anyOf, notIn } from '../db/arrays.ts';
import { query } from '../db/index.ts';
import { recordings } from '../engine/recordings.ts';
import type { RadioEntry } from './dj-radio.ts';
import { movesFrom, type KeyMode, type KeyMove } from '../../utils/music.ts';
import { like, thumb, total, type ArtistRef } from './shared.ts';

/**
 * Finding the next record to play.
 *
 * The pool is every library recording Deckhand has downloaded and analysed:
 * the tempo and the key of the real file (`deckhand.recordings`, from
 * rekordbox's analysis where the Mac sent it, else rbxport's). A track outside
 * the pool can still sit in a set, it just cannot be matched against, so it
 * shows its numbers as unknown.
 *
 * Which keys may follow which is decided in TypeScript (`movesFrom` in
 * utils/music.ts) and handed to Postgres as a table, so the suggestion list and
 * the set's transition labels read the same definition. Tempo folding is SQL
 * only, in `TEMPO_FOLD`, for the same reason in the other direction.
 */

/**
 * One row per library recording with a downloaded file whose tempo and key are
 * known.
 *
 * The display columns are left out on purpose and fetched for the rows that
 * survive the filters instead: the selective parts of every query here (a key,
 * a tempo window) run before anything needs them.
 */
const POOL = (rec: SQL) => sql`
	select lc.canonical_track_id as id,
	       r.bpm::real as bpm,
	       r.camelot as code,
	       lc.liked,
	       lc.first_added_at,
	       coalesce(cps.plays, 0) as plays
	  from library_canonical lc
	  join canonical_tracks ct on ct.id = lc.canonical_track_id
	  join ${rec} r on r.isrc = upper(ct.isrc)
	  left join canonical_play_stats cps on cps.canonical_track_id = lc.canonical_track_id
	 where r.bpm is not null and r.camelot is not null`;

/**
 * The pitch needed to match `next` to `playing`, with octaves folded.
 *
 * A tempo can read an octave out — an analysis measures within a range, so an
 * 87 BPM record and a 174 BPM one can look alike to it — and a DJ beat-matches
 * across that anyway, so the nearest of ½×, 1× and 2× wins. A lateral, because `pct` is wanted alongside
 * the factor that produced it.
 */
const TEMPO_FOLD = (playing: SQL, next: SQL) => sql`lateral (
	select f.factor, (${next} * f.factor / ${playing} - 1) * 100 as pct
	  from (values (1::real), (2::real), (0.5::real)) as f(factor)
	 order by abs(${next} * f.factor / ${playing} - 1), f.factor = 1 desc
	 limit 1
)`;

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
	added: ['p.first_added_at']
} as const;
export type DjSort = keyof typeof DJ_SORTS;

export const isDjSort = (v: string): v is DjSort => v in DJ_SORTS;

export interface BrowseFilters {
	bpmMin: number | null;
	bpmMax: number | null;
	camelot: string | null;
	q: string;
}

/** The browse filters as predicates, minus whichever dimension is being counted. */
function browseParts(f: BrowseFilters, skip?: 'bpm' | 'key'): SQL[] {
	const parts: SQL[] = [];
	if (skip !== 'bpm' && f.bpmMin != null) parts.push(sql`p.bpm >= ${f.bpmMin}`);
	if (skip !== 'bpm' && f.bpmMax != null) parts.push(sql`p.bpm < ${f.bpmMax}`);
	if (skip !== 'key' && f.camelot) parts.push(sql`p.code = ${f.camelot}`);
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
		with p as (${POOL(await recordings())})
		select ${total},
		       p.id as "canonicalTrackId",
		       p.bpm, p.code as camelot,
		       p.liked, p.plays,
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
	/** Recordings in the library with a downloaded file, analysed or not. */
	downloaded: number;
	library: number;
	/** Per Camelot code, under every filter but the key. */
	keys: { code: string; tracks: number }[];
	/** Per 5-BPM bin, under every filter but the tempo. `bin` is its lower edge. */
	tempo: { bin: number; tracks: number }[];
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
	const rec = await recordings();
	const [shape, library] = await Promise.all([
		query<{ code: string | null; bin: number | null; byKey: number; byTempo: number; pool: number }>(sql`
			with p as (
			  select p.*, greatest(${BIN_MIN}, least(${BIN_MAX - BIN}, floor(p.bpm / ${BIN}) * ${BIN}))::int as bin
			    from (${POOL(rec)}) p
			)
			select p.code, p.bin,
			       count(*) filter (where ${allOf(browseParts(filters, 'key'))})::int as "byKey",
			       count(*) filter (where ${allOf(browseParts(filters, 'bpm'))})::int as "byTempo",
			       count(*)::int as pool
			  from p
			 group by grouping sets ((p.code), (p.bin), ())
		`),
		query<{ n: number; downloaded: number }>(sql`
			select count(*)::int as n, count(r.isrc)::int as downloaded
			  from library_canonical lc
			  join canonical_tracks ct on ct.id = lc.canonical_track_id
			  left join ${rec} r on r.isrc = upper(ct.isrc)
		`)
	]);
	return {
		pool: shape.find((r) => r.code == null && r.bin == null)?.pool ?? 0,
		downloaded: library[0]?.downloaded ?? 0,
		library: library[0]?.n ?? 0,
		keys: shape
			.filter((r) => r.code != null)
			.map((r) => ({ code: r.code as string, tracks: r.byKey })),
		tempo: shape
			.filter((r) => r.bin != null)
			.map((r) => ({ bin: r.bin as number, tracks: r.byTempo }))
			.sort((a, b) => a.bin - b.bin)
	};
}

// --------------------------------------------------------------------- set

export interface SetTrack extends Display {
	position: number;
	bpm: number | null;
	camelot: string | null;
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
	const rec = await recordings();
	return query<SetTrack>(sql`
		with s as (
		  select s.id, s.ord::int as ord
		    from jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) with ordinality as s(id, ord)
		),
		r as (
		  select s.ord, ct.id, r.bpm::real as bpm, r.camelot as code,
		         lag(r.bpm::real) over (order by s.ord) as prev_bpm
		    from s
		    join canonical_tracks ct on ct.id = s.id
		    left join ${rec} r on r.isrc = upper(ct.isrc) and r.camelot is not null
		)
		select r.ord as position,
		       r.id as "canonicalTrackId",
		       r.bpm, r.code as camelot,
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

/** Why a suggestion scored on the radio: the record itself, or only its artist. */
export type RadioMatch = 'track' | 'artist';

export interface NextTrack extends DjTrack {
	move: KeyMove | null;
	tempoPct: number;
	tempoFactor: number;
	radio: RadioMatch | null;
	/** 0–1, the blend of everything below, for ranking and a bar. */
	score: number;
}

export interface NextOptions {
	tolerance: number;
	keyMode: KeyMode;
	/** A search ignores tempo and key, and only ranks by them. */
	q: string;
	exclude: string[];
	limit: number;
	/**
	 * The set's radio (`dj-radio.ts`). Empty ranks on key, tempo and plays
	 * alone, with the weights the score had before the radio.
	 */
	radio: RadioEntry[];
}

/**
 * The score's weights. With a radio, "does it belong in this set" takes most
 * of what play count had and a share of key and tempo: those two still gate,
 * so everything ranked mixes, and among what mixes the record Spotify would
 * play next should come before a stranger that happens to share the key.
 */
const WEIGHTS = {
	plain: { key: 0.55, tempo: 0.35, radio: 0, plays: 0.1 },
	radio: { key: 0.4, tempo: 0.25, radio: 0.3, plays: 0.05 }
} as const;

/**
 * An artist in the radio is a weaker sign than the record: it says the sound
 * is close, not that this track is. Their score is capped at this share of a
 * track match, reached when the artist plays twice in the last track's radio.
 */
const ARTIST_SHARE = 0.6;
const ARTIST_SATURATION = 2;

/**
 * What could follow `seed`, best first.
 *
 * The score weighs, in order: how safe the key move is, how little pitching it
 * takes, whether the set's radio plays it, and — lightly — whether it is a
 * record you actually play. The key and the tempo are gates as well as
 * weights; the radio and play count only rank.
 *
 * A folded tempo (½× or 2×) is a real mix but a riskier one, so it gives up a
 * little of its tempo score.
 *
 * The radio matches a candidate by recording, or by song — a radio plays the
 * radio edit, the library holds the extended mix, and that is the same record
 * to a DJ. Each of the set's radios counts once however many copies of the
 * song it plays, and a song in several of them adds up: that is a record the
 * whole set leads to, not only the last track.
 */
export async function nextTracks(seed: string, opts: NextOptions): Promise<NextTrack[]> {
	const pool = POOL(await recordings());
	const [s] = await query<{ code: string }>(sql`
		with p as (${pool}) select p.code from p where p.id = ${seed}
	`);
	if (!s) return [];

	const searching = opts.q !== '';
	const moves = movesFrom(s.code, searching ? 'any' : opts.keyMode);
	const tol = opts.tolerance;
	const w = opts.radio.length > 0 ? WEIGHTS.radio : WEIGHTS.plain;
	const radio = opts.radio.map((r) => ({
		seed: r.seed,
		w: r.weight,
		id: r.id,
		canonical: r.canonicalId,
		title: r.title,
		artist: r.artistIds[0] ?? null,
		artists: r.artistIds
	}));

	const gates: SQL[] = [sql`c.id ${notIn(opts.exclude)}`];
	if (!searching) gates.push(sql`abs(t.pct) <= ${tol}`);
	if (searching) {
		gates.push(sql`exists (
			select 1 from canonical_tracks x
			  left join artists a on a.id = x.primary_artist_id
			 where x.id = c.id and (${like(sql`x.title`, opts.q)} or ${like(sql`a.name`, opts.q)})
		)`);
	}

	// Gate first, then score what is left: a harmonic ±6% window is a few
	// hundred rows of nine thousand.
	return query<NextTrack>(sql`
		with p as materialized (${pool}),
		seed as materialized (select p.* from p where p.id = ${seed}),
		m as (
		  select * from jsonb_to_recordset(${JSON.stringify(moves)}::jsonb)
		    as m(code text, move text, weight real)
		),
		rad as materialized (
		  select r.seed, r.w, r.canonical, r.artists,
		         (coalesce(nullif(spotidata.song_title_key(r.title), ''), r.canonical, r.id)
		          || '|' || coalesce(r.artist, '')) as song
		    from jsonb_to_recordset(${JSON.stringify(radio)}::jsonb)
		      as r(seed int, w real, id text, canonical text, title text, artist text, artists jsonb)
		),
		rad_artist as materialized (
		  select a.id, sum(r.w) as w
		    from rad r
		    cross join jsonb_array_elements_text(r.artists) as a(id)
		   group by a.id
		),
		gated as materialized (
		  select c.*, m.move, m.weight as key_score, t.pct, t.factor
		    from p c
		    cross join seed
		    join m on m.code = c.code
		    cross join ${TEMPO_FOLD(sql`seed.bpm`, sql`c.bpm`)} t
		   where ${sql.join(gates, sql` and `)}
		),
		keyed as materialized (
		  select c.*, ${SONG('ct')} as song
		    from gated c
		    join canonical_tracks ct on ct.id = c.id
		),
		scored as (
		  select c.*,
		         greatest(0, 1 - abs(c.pct) / ${tol}) * case when c.factor = 1 then 1 else 0.8 end as tempo_score,
		         -- least() skips nulls, so the sum of no radios has to be 0 first.
		         least(1, coalesce((
		           select sum(hit.w) from (
		             select max(r.w) as w from rad r
		              where r.canonical = c.id or r.song = c.song
		              group by r.seed
		           ) hit
		         ), 0)) as radio_track,
		         ${ARTIST_SHARE} * least(1, coalesce((
		           select sum(ra.w) from canonical_track_artists cta
		             join rad_artist ra on ra.id = cta.artist_id
		            where cta.canonical_track_id = c.id and cta.on_representative
		         ), 0) / ${ARTIST_SATURATION}) as radio_artist
		    from keyed c
		),
		ranked as (
		  select distinct on (sc.song)
		         sc.*,
		         case when sc.radio_track > 0 then 'track'
		              when sc.radio_artist > 0 then 'artist' end as radio,
		         (${w.key} * sc.key_score
		        + ${w.tempo} * sc.tempo_score
		        + ${w.radio} * greatest(sc.radio_track, sc.radio_artist)
		        + ${w.plays} * least(1, ln(1 + sc.plays) / ln(50)))::real as score
		    from scored sc
		   where sc.song not in (
		           select ${SONG('x')} from canonical_tracks x where x.id = ${anyOf(opts.exclude)}
		         )
		   order by sc.song, score desc, sc.id
		)
		select r.id as "canonicalTrackId",
		       r.bpm, r.code as camelot,
		       r.liked, r.plays,
		       r.move, r.pct as "tempoPct", r.factor as "tempoFactor",
		       r.radio, r.score,
		       ${DISPLAY}
		  from ranked r
		  join canonical_tracks ct on ct.id = r.id
		 order by r.score desc, r.id
		 limit ${opts.limit}
	`);
}
