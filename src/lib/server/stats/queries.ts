import { sql } from 'drizzle-orm';
import { query } from '../db/index.ts';
import { iso, thumb, type ArtistRef } from '../entities/shared.ts';
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

/**
 * Album-level stats count real releases only.
 *
 * A compilation is someone else's sequencing — a 40-track greatest-hits package
 * or a label sampler outranks the records the library is actually built from,
 * and the same recording usually sits on the original album anyway. A NULL type
 * is an album we have not fetched in full yet, not a compilation, so it stays.
 */
const realAlbum = (alias: string) =>
	sql`${sql.raw(alias)}.album_type is distinct from 'compilation'`;

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
		       count(distinct lc.primary_artist_id)::int        as artists,
		       count(distinct al.id)::int                       as albums,
		       avg(case when liked then 1.0 else 0.0 end)       as "likedShare",
		       avg(case when explicit then 1.0 else 0.0 end)    as "explicitShare",
		       min(first_added_at)::text                        as "firstAdded",
		       max(first_added_at)::text                        as "lastAdded"
		  from library_canonical lc
		  -- Joined rather than filtered: a track whose only release is a
		  -- compilation still counts as a recording, it just adds no album.
		  left join albums al on al.id = lc.primary_album_id and ${realAlbum('al')}
		 where lc.${win(r)}
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
	delta: number;
}

/**
 * The top N artists of each year: `value` is how many of their recordings the
 * library held by the end of it, `delta` how many arrived that year, and `rank`
 * their true standing across the whole library — so #3 means third overall that
 * year, not third among the lines that happen to be drawn.
 *
 * Ranking the running total rather than the year's adds is what makes this
 * readable. A year's adds are spiky — an artist with a quiet year drops
 * hundreds of places and their line vanishes — while the total moves a place
 * or two at a time, so an artist near the top stays near the top.
 *
 * Rows are the union of every year's top N, which is wider than N: an artist
 * contributes rows only for the years they actually placed, and their line
 * breaks over the years they did not. That gap is the honest reading — they
 * were not a top artist that year — and it is why the cohort is not capped at
 * N artists. Doing that (rank the survivors against each other) is what let a
 * #659 artist draw at #10.
 */
export async function topArtistsByYear(r: Range, topN = 8): Promise<BumpRow[]> {
	const rows = await query<BumpRow>(sql`
		with per_year as (
		  -- No lower bound: a filtered view still ranks by the true library
		  -- total, the same way growth() carries its pre-window base in.
		  select extract(year from lc.first_added_at at time zone ${r.tz})::int as yr,
		         cta.artist_id, count(*)::int as n
		    from library_canonical lc
		    join canonical_track_artists cta
		      on cta.canonical_track_id = lc.canonical_track_id
		   where cta.on_representative and cta.position = 0
		     and lc.first_added_at < ${r.to}
		   group by 1, 2
		), grid as (
		  -- Every artist gets a row per year so the running total carries across
		  -- years they added nothing, instead of skipping to their next add.
		  select y.yr, a.artist_id
		    from generate_series((select min(yr) from per_year),
		                         (select max(yr) from per_year)) as y(yr)
		   cross join (select distinct artist_id from per_year) a
		), cumulative as (
		  select g.yr, g.artist_id,
		         coalesce(p.n, 0) as added,
		         sum(coalesce(p.n, 0)) over (partition by g.artist_id order by g.yr)::int
		           as total
		    from grid g
		    left join per_year p on p.yr = g.yr and p.artist_id = g.artist_id
		), shown as (
		  -- Artists appear the year their first track lands, and the pre-window
		  -- years drop out now that they have done their job for the totals.
		  select * from cumulative
		   where total > 0
		     and yr >= extract(year from ${r.from}::timestamptz at time zone ${r.tz})::int
		), ranked as (
		  -- Ranked against the whole library, not against the cohort: this is the
		  -- number the chart prints on its axis, so it has to be the real one.
		  select *, row_number() over (partition by yr order by total desc, artist_id) as rk
		    from shown
		)
		select r.yr as period, r.artist_id as key, a.name as label,
		       r.rk::int as rank, r.total as value, r.added::int as delta
		  from ranked r
		  join artists a on a.id = r.artist_id
		 where r.rk <= ${topN}
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
		       count(distinct al.id)::int                 as albums,
		       (select url from artist_images
		         where artist_id = a.id order by position desc limit 1) as "imageUrl"
		  from library_canonical lc
		  join canonical_track_artists cta
		    on cta.canonical_track_id = lc.canonical_track_id
		  join artists a on a.id = cta.artist_id
		  left join albums al on al.id = lc.primary_album_id and ${realAlbum('al')}
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
 *
 * Either way the compilation itself is never a row here: it is a candidate
 * album only in the sense that it happens to carry the recording.
 *
 * Singles are dropped too — a saved single is a complete "album" by
 * definition, so they would crowd out the records the panel is asking about.
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
		 where ${realAlbum('al')} and al.album_type is distinct from 'single'
		   and lc.${win(r)}
		   ${strict ? sql`and st.id in (select track_id from library_tracks)` : sql``}
		 group by al.id, al.name, al.total_tracks
		having al.total_tracks >= ${minTracks}
		   and count(distinct lc.canonical_track_id) <= al.total_tracks
		 order by ${orderBy === 'pct' ? sql`pct desc nulls last, saved desc` : sql`saved desc, pct desc nulls last`}
		 limit ${limit}
	`);
	return rows;
}

export interface PlaylistCount {
	id: string;
	name: string;
	isOwned: boolean;
	tracks: number;
	inLibrary: number;
	imageUrl: string | null;
}

/**
 * Playlists by how many items landed in them inside the window.
 *
 * This is the one panel that cannot key off `library_canonical`: a playlist's
 * own `added_at` is what makes it answer to the range picker. All-time skips
 * the filter entirely rather than bounding it, so the counts match the
 * playlists page — `r.from` is the first *library* addition (later than an
 * older non-owned playlist's items) and `added_at` is null for items Spotify
 * never dated.
 */
export async function topPlaylists(r: Range, limit = 10): Promise<PlaylistCount[]> {
	const rows = await query<PlaylistCount>(sql`
		select p.id, p.name, p.is_owned as "isOwned",
		       count(*)::int                    as tracks,
		       count(lt.track_id)::int          as "inLibrary",
		       ${thumb('playlist_images', 'playlist_id', 'p.id')} as "imageUrl"
		  from playlists p
		  join playlist_tracks pt on pt.playlist_id = p.id
		  left join library_tracks lt on lt.track_id = pt.track_id
		 where p.removed_at is null
		   ${r.isAllTime ? sql`` : sql`and pt.added_at >= ${r.from} and pt.added_at < ${r.to}`}
		 group by p.id, p.name, p.is_owned
		 order by tracks desc, p.name
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
		 where al.label is not null and ${realAlbum('al')} and lc.${win(r)}
		 group by al.label
		 order by tracks desc
		 limit ${limit}
	`);
	return rows;
}

// ------------------------------------------------------- latest additions

export interface RecentTrack {
	canonicalTrackId: string;
	title: string;
	addedAt: string;
	liked: boolean;
	albumId: string | null;
	albumName: string | null;
	cover: string | null;
	artists: ArtistRef[];
}

/** The newest recordings in the window — the top of the library list, with art. */
export async function recentAdditions(r: Range, limit = 12): Promise<RecentTrack[]> {
	const rows = await query<RecentTrack>(sql`
		select ct.id                as "canonicalTrackId",
		       ct.title,
		       ${iso('lc.first_added_at')} as "addedAt",
		       lc.liked,
		       al.id                as "albumId",
		       al.name              as "albumName",
		       ${thumb('album_images', 'album_id', 'al.id')} as cover,
		       coalesce((
		         select jsonb_agg(jsonb_build_object('id', ar.id, 'name', ar.name)
		                          order by cta.position)
		           from canonical_track_artists cta
		           join artists ar on ar.id = cta.artist_id
		          where cta.canonical_track_id = ct.id and cta.on_representative
		       ), '[]'::jsonb)      as artists
		  from library_canonical lc
		  join canonical_tracks ct on ct.id = lc.canonical_track_id
		  left join albums al on al.id = ct.primary_album_id
		 where lc.${win(r)}
		 order by lc.first_added_at desc, ct.title
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
	artistId: string | null;
	cover: string | null;
	copies: number;
	names: string[];
}

export async function duplicates(r: Range, limit = 20): Promise<DuplicateRow[]> {
	const rows = await query<DuplicateRow>(sql`
		select ct.id as "canonicalTrackId", ct.title,
		       a.name as artist, a.id as "artistId", ct.copy_count as copies,
		       ${thumb('album_images', 'album_id', 'ct.primary_album_id')} as cover,
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
