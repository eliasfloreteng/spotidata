import { sql } from 'drizzle-orm';
import { query } from '../db/index.ts';
import type { Range } from './range.ts';

/**
 * Analytics live in raw SQL rather than the query builder: these need window
 * functions, generate_series gap-filling, FILTER and lateral joins, which the
 * builder makes harder to read rather than easier.
 *
 * Every date bucket goes through `AT TIME ZONE` — the library spans years and
 * a UTC bucket puts late-evening Stockholm saves on the wrong day.
 *
 * All of this reads `library_canonical` (~8.8k rows), so no materialized views:
 * each query is a GROUP BY over a table that fits in shared buffers, and MVs
 * cannot be parameterized by an arbitrary time range anyway.
 */

const win = (r: Range) => sql`first_added_at >= ${r.from} and first_added_at < ${r.to}`;

// ------------------------------------------------------------- headline

export interface Totals {
	recordings: number;
	copies: number;
	durationMs: number;
	artists: number;
	albums: number;
	likedShare: number | null;
	explicitShare: number | null;
	firstAdded: string | null;
	lastAdded: string | null;
}

export async function totals(r: Range): Promise<Totals> {
	const rows = await query<Totals>(sql`
		select count(*)::int                                    as recordings,
		       coalesce(sum(copy_count_in_library), 0)::int     as copies,
		       coalesce(sum(duration_ms), 0)::bigint            as "durationMs",
		       count(distinct primary_artist_id)::int           as artists,
		       count(distinct primary_album_id)::int            as albums,
		       avg(case when liked then 1.0 else 0.0 end)       as "likedShare",
		       avg(case when explicit then 1.0 else 0.0 end)    as "explicitShare",
		       min(first_added_at)::text                        as "firstAdded",
		       max(first_added_at)::text                        as "lastAdded"
		  from library_canonical
		 where ${win(r)}
	`);
	return (
		rows[0] ?? {
			recordings: 0,
			copies: 0,
			durationMs: 0,
			artists: 0,
			albums: 0,
			likedShare: null,
			explicitShare: null,
			firstAdded: null,
			lastAdded: null
		}
	);
}

// ------------------------------------------------------ calendar heatmap

export interface DayCount {
	day: string;
	value: number;
}

export async function additionsByDay(r: Range): Promise<DayCount[]> {
	const rows = await query<DayCount>(sql`
		select to_char((first_added_at at time zone ${r.tz})::date, 'YYYY-MM-DD') as day,
		       count(*)::int as value
		  from library_canonical
		 where ${win(r)}
		 group by 1 order by 1
	`);
	return rows;
}

// -------------------------------------------------------------- growth

export interface GrowthPoint {
	period: string;
	added: number;
	cumulative: number;
}

/** Monthly additions plus a running total, gap-filled so months with no adds show. */
export async function growth(r: Range): Promise<GrowthPoint[]> {
	const rows = await query<GrowthPoint>(sql`
		with months as (
		  select generate_series(
		    date_trunc('month', ${r.from}::timestamptz at time zone ${r.tz}),
		    date_trunc('month', ${r.to}::timestamptz at time zone ${r.tz}),
		    interval '1 month') as m
		), adds as (
		  select date_trunc('month', first_added_at at time zone ${r.tz}) as m,
		         count(*)::int as n
		    from library_canonical where ${win(r)} group by 1
		), base as (
		  -- Everything already in the library before the window, so a filtered
		  -- view still shows the true running total rather than restarting at 0.
		  select count(*)::int as n from library_canonical
		   where first_added_at < ${r.from}
		)
		select to_char(months.m, 'YYYY-MM') as period,
		       coalesce(adds.n, 0) as added,
		       ((select n from base) + sum(coalesce(adds.n, 0)) over (order by months.m))::int
		         as cumulative
		  from months left join adds using (m)
		 order by months.m
	`);
	return rows;
}

// ----------------------------------------------------------- bump chart

export interface BumpRow {
	period: number;
	key: string;
	label: string;
	rank: number;
	value: number;
}

/** Top-N artists per year, including every artist that ever reached the top N. */
export async function topArtistsByYear(r: Range, topN = 8): Promise<BumpRow[]> {
	const rows = await query<BumpRow>(sql`
		with per_year as (
		  select extract(year from lc.first_added_at at time zone ${r.tz})::int as yr,
		         cta.artist_id, count(*)::int as n
		    from library_canonical lc
		    join canonical_track_artists cta
		      on cta.canonical_track_id = lc.canonical_track_id
		   where cta.on_representative and cta.position = 0
		     and lc.${win(r)}
		   group by 1, 2
		), ranked as (
		  select *, row_number() over (partition by yr order by n desc, artist_id) as rk
		    from per_year
		), keep as (
		  -- Keeping every artist that ever cracked the top N piles ~30 series
		  -- onto one chart. Rank the contenders by how often they placed (then
		  -- by total volume) and keep only that many lines.
		  select artist_id
		    from ranked
		   where rk <= ${topN}
		   group by artist_id
		   order by count(*) desc, sum(n) desc
		   limit ${topN}
		)
		select r.yr as period, r.artist_id as key, a.name as label,
		       r.rk::int as rank, r.n as value
		  from ranked r
		  join keep k on k.artist_id = r.artist_id
		  join artists a on a.id = r.artist_id
		 order by r.yr, r.rk
	`);
	return rows;
}

// ------------------------------------------------------------ leaderboards

export interface ArtistCount {
	id: string;
	name: string;
	tracks: number;
	albums: number;
	imageUrl: string | null;
}

export async function topArtists(r: Range, limit = 25): Promise<ArtistCount[]> {
	const rows = await query<ArtistCount>(sql`
		select a.id, a.name,
		       count(distinct lc.canonical_track_id)::int as tracks,
		       count(distinct lc.primary_album_id)::int   as albums,
		       (select url from artist_images
		         where artist_id = a.id order by position desc limit 1) as "imageUrl"
		  from library_canonical lc
		  join canonical_track_artists cta
		    on cta.canonical_track_id = lc.canonical_track_id
		  join artists a on a.id = cta.artist_id
		 where cta.on_representative and lc.${win(r)}
		 group by a.id, a.name
		 order by tracks desc, a.name
		 limit ${limit}
	`);
	return rows;
}

export interface AlbumCompletion {
	id: string;
	name: string;
	artist: string | null;
	totalTracks: number;
	saved: number;
	pct: number;
	imageUrl: string | null;
}

/**
 * Albums by how much of them the library holds.
 *
 * `strict` decides what counts: loose (default) joins through every copy of a
 * recording, so a song saved off a compilation still credits the original
 * album — "do I have this record?". Strict counts only the exact track rows
 * in the library.
 */
export async function albumCompletion(
	r: Range,
	opts: { minTracks?: number; limit?: number; strict?: boolean; orderBy?: 'pct' | 'saved' } = {}
): Promise<AlbumCompletion[]> {
	const { minTracks = 5, limit = 30, strict = false, orderBy = 'pct' } = opts;
	const rows = await query<AlbumCompletion>(sql`
		select al.id, al.name,
		       (select a.name from album_artists aa join artists a on a.id = aa.artist_id
		         where aa.album_id = al.id order by aa.position limit 1) as artist,
		       al.total_tracks as "totalTracks",
		       count(distinct lc.canonical_track_id)::int as saved,
		       round(count(distinct lc.canonical_track_id)::numeric
		             / nullif(al.total_tracks, 0), 4)::float8 as pct,
		       (select url from album_images
		         where album_id = al.id order by position desc limit 1) as "imageUrl"
		  from library_canonical lc
		  join spotify_tracks st on st.canonical_track_id = lc.canonical_track_id
		  join albums al on al.id = st.album_id
		 where lc.${win(r)}
		   ${strict ? sql`and st.id in (select track_id from library_tracks)` : sql``}
		 group by al.id, al.name, al.total_tracks
		having al.total_tracks >= ${minTracks}
		   and count(distinct lc.canonical_track_id) <= al.total_tracks
		 order by ${orderBy === 'pct' ? sql`pct desc nulls last, saved desc` : sql`saved desc, pct desc nulls last`}
		 limit ${limit}
	`);
	return rows;
}

export interface LabelCount {
	label: string;
	tracks: number;
	albums: number;
}

export async function topLabels(r: Range, limit = 15): Promise<LabelCount[]> {
	const rows = await query<LabelCount>(sql`
		select al.label,
		       count(distinct lc.canonical_track_id)::int as tracks,
		       count(distinct al.id)::int as albums
		  from library_canonical lc
		  join spotify_tracks st on st.canonical_track_id = lc.canonical_track_id
		  join albums al on al.id = st.album_id
		 where al.label is not null and lc.${win(r)}
		 group by al.label
		 order by tracks desc
		 limit ${limit}
	`);
	return rows;
}

// -------------------------------------------------------- distributions

export interface Bucket {
	bucket: number;
	count: number;
}

export async function releaseYears(r: Range): Promise<Bucket[]> {
	const rows = await query<Bucket>(sql`
		select extract(year from ct.earliest_release_date)::int as bucket,
		       count(*)::int as count
		  from library_canonical lc
		  join canonical_tracks ct on ct.id = lc.canonical_track_id
		 where ct.earliest_release_date is not null and lc.${win(r)}
		 group by 1 order by 1
	`);
	return rows;
}

export async function trackDurations(r: Range): Promise<Bucket[]> {
	const rows = await query<Bucket>(sql`
		select (duration_ms / 30000) * 30 as bucket, count(*)::int as count
		  from library_canonical
		 where duration_ms between 1 and 1800000 and ${win(r)}
		 group by 1 order by 1
	`);
	return rows;
}

/** Hour-of-day × weekday of when tracks were saved. */
export interface ClockCell {
	weekday: number;
	hour: number;
	count: number;
}

export async function addTimeHeatmap(r: Range): Promise<ClockCell[]> {
	const rows = await query<ClockCell>(sql`
		select extract(isodow from first_added_at at time zone ${r.tz})::int as weekday,
		       extract(hour   from first_added_at at time zone ${r.tz})::int as hour,
		       count(*)::int as count
		  from library_canonical
		 where ${win(r)}
		 group by 1, 2 order by 1, 2
	`);
	return rows;
}

/**
 * Time between a track's release and the day it entered the library.
 * A falling median means the collection is tracking new music more closely.
 */
export interface LagPoint {
	year: number;
	medianDays: number;
	p25: number;
	p75: number;
	n: number;
}

export async function discoveryLag(r: Range): Promise<LagPoint[]> {
	const rows = await query<LagPoint>(sql`
		with lags as (
		  select extract(year from lc.first_added_at at time zone ${r.tz})::int as year,
		         ((lc.first_added_at at time zone ${r.tz})::date
		            - ct.earliest_release_date)::int as days
		    from library_canonical lc
		    join canonical_tracks ct on ct.id = lc.canonical_track_id
		   where ct.earliest_release_date is not null and lc.${win(r)}
		)
		select year,
		       percentile_cont(0.5)  within group (order by days)::int as "medianDays",
		       percentile_cont(0.25) within group (order by days)::int as p25,
		       percentile_cont(0.75) within group (order by days)::int as p75,
		       count(*)::int as n
		  from lags
		 where days >= 0
		 group by year order by year
	`);
	return rows;
}

/**
 * Each month split into tracks by an artist new to the library versus one
 * already present — collecting breadth versus deepening.
 */
export interface DiscoverySplit {
	period: string;
	newArtists: number;
	existing: number;
}

export async function newVsDeepening(r: Range): Promise<DiscoverySplit[]> {
	const rows = await query<DiscoverySplit>(sql`
		with firsts as (
		  select primary_artist_id, min(first_added_at) as first_seen -- sql-lint: internal
		    from library_canonical
		   where primary_artist_id is not null
		   group by 1
		)
		select to_char(date_trunc('month', lc.first_added_at at time zone ${r.tz}), 'YYYY-MM')
		         as period,
		       count(*) filter (
		         where date_trunc('month', lc.first_added_at at time zone ${r.tz})
		             = date_trunc('month', f.first_seen at time zone ${r.tz})
		       )::int as "newArtists",
		       count(*) filter (
		         where date_trunc('month', lc.first_added_at at time zone ${r.tz})
		            <> date_trunc('month', f.first_seen at time zone ${r.tz})
		       )::int as existing
		  from library_canonical lc
		  join firsts f on f.primary_artist_id = lc.primary_artist_id
		 where lc.${win(r)}
		 group by 1 order by 1
	`);
	return rows;
}

/** Recordings held under the most distinct Spotify track ids. */
export interface DuplicateRow {
	canonicalTrackId: string;
	title: string;
	artist: string | null;
	copies: number;
	names: string[];
}

export async function duplicates(r: Range, limit = 20): Promise<DuplicateRow[]> {
	const rows = await query<DuplicateRow>(sql`
		select ct.id as "canonicalTrackId", ct.title,
		       a.name as artist, ct.copy_count as copies,
		       (select array_agg(distinct st.name)
		          from spotify_tracks st where st.canonical_track_id = ct.id) as names
		  from library_canonical lc
		  join canonical_tracks ct on ct.id = lc.canonical_track_id
		  left join artists a on a.id = ct.primary_artist_id
		 where ct.copy_count > 1 and lc.${win(r)}
		 order by ct.copy_count desc, ct.title
		 limit ${limit}
	`);
	return rows;
}

/** Longest run of consecutive days with at least one addition. */
export interface Streaks {
	longest: number;
	longestEnd: string | null;
	current: number;
	busiestDay: string | null;
	busiestCount: number;
	activeDays: number;
}

export async function streaks(r: Range): Promise<Streaks> {
	const rows = await query<Streaks>(sql`
		with days as (
		  select (first_added_at at time zone ${r.tz})::date as d, count(*)::int as n
		    from library_canonical where ${win(r)} group by 1
		), grouped as (
		  -- Consecutive dates share (date - row_number), the classic gaps-and-islands trick.
		  select d, n, d - (row_number() over (order by d))::int as grp from days
		), runs as (
		  select grp, count(*)::int as len, max(d) as ended from grouped group by grp
		), busiest as (
		  select d, n from days order by n desc, d desc limit 1
		)
		select coalesce((select max(len) from runs), 0) as longest,
		       (select to_char(ended,'YYYY-MM-DD') from runs order by len desc, ended desc limit 1)
		         as "longestEnd",
		       coalesce((select len from runs
		                  where ended >= (current_date - 1) order by ended desc limit 1), 0)
		         as current,
		       (select to_char(d,'YYYY-MM-DD') from busiest) as "busiestDay",
		       coalesce((select n from busiest), 0) as "busiestCount",
		       (select count(*)::int from days) as "activeDays"
	`);
	return (
		rows[0] ?? {
			longest: 0,
			longestEnd: null,
			current: 0,
			busiestDay: null,
			busiestCount: 0,
			activeDays: 0
		}
	);
}

/** Only meaningful once popularity is populated; the caller feature-flags it. */
export async function popularityDistribution(r: Range): Promise<Bucket[]> {
	const rows = await query<Bucket>(sql`
		select (ct.max_popularity / 5) * 5 as bucket, count(*)::int as count
		  from library_canonical lc
		  join canonical_tracks ct on ct.id = lc.canonical_track_id
		 where ct.max_popularity is not null and lc.${win(r)}
		 group by 1 order by 1
	`);
	return rows;
}
