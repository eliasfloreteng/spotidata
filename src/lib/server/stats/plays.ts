import { sql } from 'drizzle-orm';
import { query } from '../db/index.ts';
import { iso, thumb, type ArtistRef } from '../entities/shared.ts';
import type { Range } from './range.ts';

/**
 * Listening statistics — what was played, as opposed to what was kept.
 *
 * These read `plays` directly rather than the `canonical_play_stats` rollup:
 * that table exists so a list page can order 8.8k recordings without touching
 * 167k events, but it cannot be re-cut by an arbitrary window and everything
 * here answers to the range picker. 167k rows is a sub-100ms GROUP BY and the
 * table sits in shared buffers, so the honest query is also the fast one.
 *
 * A play joins the catalog through `spotify_tracks`, never directly to a
 * canonical id — see the note on `plays.trackId`. Plays whose URI the catalog
 * has never seen drop out of every recording-level number and stay in the
 * event-level ones; `coverage()` is what makes that gap visible rather than
 * silent.
 */

const win = (r: Range) => sql`p.played_at >= ${r.from} and p.played_at < ${r.to}`;

/** Streams past this mark count as listened to; below it, as skipped. */
const COMPLETE = sql`p.ms_played >= spotidata.play_completion_ms()`;

/**
 * `platform` is free text and has drifted through eight years of clients:
 * "iOS 11.4.1 (iPhone9,3)", "web_player windows 10;chrome 67.0;desktop",
 * "android", "Partner spotify web_player". Ordering matters — a partner
 * integration names the host platform inside its own string, so it has to be
 * tested before the generic web and desktop patterns claim it.
 */
const DEVICE = sql`
	case
	  when p.platform is null then 'Unknown'
	  when p.platform ilike 'ios%' or p.platform ilike '%iphone%' or p.platform ilike '%ipad%'
	    then 'iOS'
	  when p.platform ilike 'android%' then 'Android'
	  when p.platform ilike 'partner%' or p.platform ilike '%cast%'
	    or p.platform ilike '%sonos%' or p.platform ilike '%speaker%'
	    then 'Speaker & partner'
	  when p.platform ilike '%web_player%' or p.platform ilike 'web player%' then 'Web player'
	  when p.platform ilike 'windows%' then 'Windows'
	  when p.platform ilike 'osx%' or p.platform ilike 'os x%' or p.platform ilike 'macos%'
	    then 'macOS'
	  when p.platform ilike 'linux%' then 'Linux'
	  else 'Other'
	end`;

// ------------------------------------------------------------------ headline

export interface ListeningTotals {
	plays: number;
	msPlayed: number;
	completed: number;
	skipped: number;
	recordings: number;
	artists: number;
	albums: number;
	activeDays: number;
	spanDays: number;
	inLibraryPlays: number;
	firstPlayed: string | null;
	lastPlayed: string | null;
}

export async function listeningTotals(r: Range): Promise<ListeningTotals> {
	const rows = await query<ListeningTotals>(sql`
		select count(*)::int                                     as plays,
		       coalesce(sum(p.ms_played), 0)::bigint             as "msPlayed",
		       count(*) filter (where ${COMPLETE})::int          as completed,
		       count(*) filter (where p.ms_played < spotidata.play_completion_ms())::int
		                                                         as skipped,
		       count(distinct st.canonical_track_id)::int        as recordings,
		       count(distinct ct.primary_album_id)::int          as albums,
		       count(distinct (p.played_at at time zone ${r.tz})::date)::int as "activeDays",
		       (extract(epoch from (${r.to}::timestamptz - ${r.from}::timestamptz)) / 86400)::int
		                                                         as "spanDays",
		       count(*) filter (where lc.canonical_track_id is not null)::int as "inLibraryPlays",
		       ${iso('min(p.played_at)')}                        as "firstPlayed",
		       ${iso('max(p.played_at)')}                        as "lastPlayed",
		       -- A separate scan rather than another join: the artist credits are
		       -- the one relation here that is not one-to-one with a play, and
		       -- joining them multiplies every count above by the credit list.
		       (select count(distinct cta.artist_id)::int
		          from plays p2
		          join spotify_tracks st2 on st2.id = p2.track_id
		          join canonical_track_artists cta
		            on cta.canonical_track_id = st2.canonical_track_id and cta.on_representative
		         where p2.played_at >= ${r.from} and p2.played_at < ${r.to}) as artists
		  from plays p
		  left join spotify_tracks st on st.id = p.track_id
		  left join canonical_tracks ct on ct.id = st.canonical_track_id
		  left join library_canonical lc on lc.canonical_track_id = ct.id
		 where ${win(r)}
	`);
	return (
		rows[0] ?? {
			plays: 0,
			msPlayed: 0,
			completed: 0,
			skipped: 0,
			recordings: 0,
			artists: 0,
			albums: 0,
			activeDays: 0,
			spanDays: 0,
			inLibraryPlays: 0,
			firstPlayed: null,
			lastPlayed: null
		}
	);
}

// -------------------------------------------------------------- distributions

export interface DayMinutes {
	day: string;
	value: number;
}

/**
 * Minutes listened per day — the calendar heatmap.
 *
 * `sum(ms_played)` is NULL, not 0, for a day whose plays all came from the API
 * — that source records no duration. Every aggregate over `ms_played` in this
 * file coalesces for that reason: the untreated NULL does not read as an empty
 * day, it sorts FIRST under `order by … desc` and quietly wins "biggest day".
 */
export async function minutesByDay(r: Range): Promise<DayMinutes[]> {
	return query<DayMinutes>(sql`
		select to_char((p.played_at at time zone ${r.tz})::date, 'YYYY-MM-DD') as day,
		       round(coalesce(sum(p.ms_played), 0) / 60000.0)::int as value
		  from plays p
		 where ${win(r)}
		 group by 1 having coalesce(sum(p.ms_played), 0) > 0 order by 1
	`);
}

export interface MonthPoint {
	period: string;
	minutes: number;
	plays: number;
	libraryMinutes: number;
}

/**
 * Monthly listening, gap-filled, split by whether the recording is one the
 * library holds — the "am I listening to my own collection?" question that
 * neither table can answer alone.
 */
export async function listeningByMonth(r: Range): Promise<MonthPoint[]> {
	return query<MonthPoint>(sql`
		with months as (
		  select generate_series(
		    date_trunc('month', ${r.from}::timestamptz at time zone ${r.tz}),
		    date_trunc('month', ${r.to}::timestamptz at time zone ${r.tz}),
		    interval '1 month') as m
		), played as (
		  select date_trunc('month', p.played_at at time zone ${r.tz}) as m,
		         round(coalesce(sum(p.ms_played), 0) / 60000.0)::int as minutes,
		         count(*)::int as plays,
		         round(coalesce(sum(p.ms_played) filter (
		           where lc.canonical_track_id is not null), 0) / 60000.0)::int as library_minutes
		    from plays p
		    left join spotify_tracks st on st.id = p.track_id
		    left join library_canonical lc on lc.canonical_track_id = st.canonical_track_id
		   where ${win(r)}
		   group by 1
		)
		select to_char(months.m, 'YYYY-MM') as period,
		       coalesce(played.minutes, 0) as minutes,
		       coalesce(played.plays, 0)   as plays,
		       coalesce(played.library_minutes, 0) as "libraryMinutes"
		  from months left join played using (m)
		 order by months.m
	`);
}

export interface ClockCell {
	weekday: number;
	hour: number;
	count: number;
}

/** Hour-of-day × weekday, in minutes — when listening actually happens. */
export async function listeningClock(r: Range): Promise<ClockCell[]> {
	return query<ClockCell>(sql`
		select extract(isodow from p.played_at at time zone ${r.tz})::int as weekday,
		       extract(hour   from p.played_at at time zone ${r.tz})::int as hour,
		       round(coalesce(sum(p.ms_played), 0) / 60000.0)::int as count
		  from plays p
		 where ${win(r)}
		 group by 1, 2 order by 1, 2
	`);
}

export interface ShareRow {
	label: string;
	value: number;
}

/** Listening minutes by device family. */
export async function deviceShare(r: Range): Promise<ShareRow[]> {
	return query<ShareRow>(sql`
		select ${DEVICE} as label,
		       round(coalesce(sum(p.ms_played), 0) / 60000.0)::int as value
		  from plays p
		 where ${win(r)}
		 group by 1 having coalesce(sum(p.ms_played), 0) > 0 order by value desc
	`);
}

/** Listening minutes by the country the client connected from. */
export async function countryShare(r: Range, limit = 8): Promise<ShareRow[]> {
	return query<ShareRow>(sql`
		select coalesce(nullif(p.conn_country, 'ZZ'), 'Unknown') as label,
		       round(coalesce(sum(p.ms_played), 0) / 60000.0)::int as value
		  from plays p
		 where ${win(r)}
		 group by 1 having coalesce(sum(p.ms_played), 0) > 0 order by value desc
		 limit ${limit}
	`);
}

/**
 * How streams end. `reason_end` is the export's own vocabulary — `trackdone`
 * is a track played out, `fwdbtn` a skip, `endplay` the app being closed on it
 * — and it is the only field that distinguishes a deliberate skip from an
 * interruption.
 */
export async function endReasons(r: Range, limit = 8): Promise<ShareRow[]> {
	return query<ShareRow>(sql`
		select coalesce(p.reason_end, 'unknown') as label, count(*)::int as value
		  from plays p
		 where ${win(r)} and p.reason_end is not null
		 group by 1 order by value desc limit ${limit}
	`);
}

/** Distribution of how far into a track a stream got, as a percentage bucket. */
export interface Bucket {
	bucket: number;
	count: number;
}

export async function completionBuckets(r: Range): Promise<Bucket[]> {
	return query<Bucket>(sql`
		select least(10, (p.ms_played * 10 / nullif(ct.duration_ms, 0)))::int * 10 as bucket,
		       count(*)::int as count
		  from plays p
		  join spotify_tracks st on st.id = p.track_id
		  join canonical_tracks ct on ct.id = st.canonical_track_id
		 where ${win(r)} and p.ms_played is not null and ct.duration_ms > 0
		 group by 1 order by 1
	`);
}

// ------------------------------------------------------------- leaderboards

export interface PlayedTrack {
	canonicalTrackId: string;
	title: string;
	plays: number;
	completed: number;
	msPlayed: number;
	lastPlayedAt: string | null;
	inLibrary: boolean;
	cover: string | null;
	artists: ArtistRef[];
}

/**
 * Most-played recordings. `inLibrary` decides whether the panel asks "what did
 * I play?" or "what did I play that I never saved?" — the second is the one
 * the library tables cannot answer at all.
 */
export async function topPlayedTracks(
	r: Range,
	opts: { limit?: number; inLibrary?: boolean } = {}
): Promise<PlayedTrack[]> {
	const { limit = 20, inLibrary } = opts;
	const filter =
		inLibrary === undefined
			? sql``
			: inLibrary
				? sql`and lc.canonical_track_id is not null`
				: sql`and lc.canonical_track_id is null`;
	return query<PlayedTrack>(sql`
		select ct.id                            as "canonicalTrackId",
		       ct.title,
		       count(*)::int                    as plays,
		       count(*) filter (where ${COMPLETE})::int as completed,
		       coalesce(sum(p.ms_played), 0)::bigint    as "msPlayed",
		       ${iso('max(p.played_at)')}       as "lastPlayedAt",
		       bool_or(lc.canonical_track_id is not null) as "inLibrary",
		       ${thumb('album_images', 'album_id', 'ct.primary_album_id')} as cover,
		       coalesce((
		         select jsonb_agg(jsonb_build_object('id', ar.id, 'name', ar.name)
		                          order by cta.position)
		           from canonical_track_artists cta
		           join artists ar on ar.id = cta.artist_id
		          where cta.canonical_track_id = ct.id and cta.on_representative
		       ), '[]'::jsonb)                  as artists
		  from plays p
		  join spotify_tracks st on st.id = p.track_id
		  join canonical_tracks ct on ct.id = st.canonical_track_id
		  left join library_canonical lc on lc.canonical_track_id = ct.id
		 where ${win(r)} ${filter}
		 group by ct.id, ct.title, ct.primary_album_id
		 order by "msPlayed" desc, plays desc, ct.title
		 limit ${limit}
	`);
}

export interface PlayedArtist {
	id: string;
	name: string;
	plays: number;
	msPlayed: number;
	recordings: number;
	imageUrl: string | null;
}

export async function topPlayedArtists(r: Range, limit = 20): Promise<PlayedArtist[]> {
	return query<PlayedArtist>(sql`
		select a.id, a.name,
		       count(*)::int                             as plays,
		       coalesce(sum(p.ms_played), 0)::bigint     as "msPlayed",
		       count(distinct ct.id)::int                as recordings,
		       ${thumb('artist_images', 'artist_id', 'a.id')} as "imageUrl"
		  from plays p
		  join spotify_tracks st on st.id = p.track_id
		  join canonical_tracks ct on ct.id = st.canonical_track_id
		  -- Every credited artist, so a guest verse counts toward the guest too;
		  -- the headline artist count in listeningTotals uses position 0 only.
		  join canonical_track_artists cta
		    on cta.canonical_track_id = ct.id and cta.on_representative
		  join artists a on a.id = cta.artist_id
		 where ${win(r)}
		 group by a.id, a.name
		 order by "msPlayed" desc, plays desc, a.name
		 limit ${limit}
	`);
}

export interface PlayedAlbum {
	id: string;
	name: string;
	artist: string | null;
	plays: number;
	msPlayed: number;
	recordings: number;
	imageUrl: string | null;
}

export async function topPlayedAlbums(r: Range, limit = 15): Promise<PlayedAlbum[]> {
	return query<PlayedAlbum>(sql`
		select al.id, al.name,
		       (select ar.name from album_artists aa join artists ar on ar.id = aa.artist_id
		         where aa.album_id = al.id order by aa.position limit 1) as artist,
		       count(*)::int                          as plays,
		       coalesce(sum(p.ms_played), 0)::bigint  as "msPlayed",
		       count(distinct ct.id)::int             as recordings,
		       ${thumb('album_images', 'album_id', 'al.id')} as "imageUrl"
		  from plays p
		  join spotify_tracks st on st.id = p.track_id
		  join canonical_tracks ct on ct.id = st.canonical_track_id
		  join albums al on al.id = ct.primary_album_id
		 where ${win(r)} and al.album_type is distinct from 'single'
		 group by al.id, al.name
		 order by "msPlayed" desc, plays desc, al.name
		 limit ${limit}
	`);
}

export interface BumpRow {
	period: number;
	key: string;
	label: string;
	rank: number;
	value: number;
	delta: number;
}

/**
 * Each year's most-listened artists, ranked on that year alone.
 *
 * The same shape as the library's bump chart and for the same reason: a
 * running total barely moves once it is large, so every year after the first
 * would read as a copy of it. `value` is hours, which is the unit a year of
 * listening is actually felt in.
 */
export async function topArtistsByYearPlayed(r: Range, topN = 10): Promise<BumpRow[]> {
	return query<BumpRow>(sql`
		with per_year as (
		  -- One year of padding either side so the first shown year still has a
		  -- predecessor to compare against; it drops out after ranking.
		  select extract(year from p.played_at at time zone ${r.tz})::int as yr,
		         cta.artist_id,
		         round(coalesce(sum(p.ms_played), 0) / 3600000.0)::int as hours
		    from plays p
		    join spotify_tracks st on st.id = p.track_id
		    join canonical_track_artists cta
		      on cta.canonical_track_id = st.canonical_track_id
		     and cta.on_representative and cta.position = 0
		   where p.played_at >= ${r.from}::timestamptz - interval '1 year'
		     and p.played_at < ${r.to}
		   group by 1, 2
		), ranked as (
		  select y.yr, y.artist_id, y.hours,
		         y.hours - coalesce(prev.hours, 0) as change,
		         row_number() over (partition by y.yr order by y.hours desc, y.artist_id) as rk
		    from per_year y
		    -- The previous CALENDAR year, not the artist's previous appearance.
		    left join per_year prev on prev.artist_id = y.artist_id and prev.yr = y.yr - 1
		)
		select rk.yr as period, rk.artist_id as key, a.name as label,
		       rk.rk::int as rank, rk.hours as value, rk.change::int as delta
		  from ranked rk
		  join artists a on a.id = rk.artist_id
		 where rk.rk <= ${topN}
		   and rk.hours > 0
		   and rk.yr >= extract(year from ${r.from}::timestamptz at time zone ${r.tz})::int
		 order by rk.yr, rk.rk
	`);
}

// ------------------------------------------------------------------- rhythm

export interface DiscoverySplit {
	period: string;
	firstTime: number;
	revisited: number;
}

/**
 * Each month's plays split into recordings heard for the first time ever and
 * ones already known — discovery against repetition.
 *
 * "First time" is measured against the whole log, not the window, so a
 * filtered view does not relabel an old favourite as a discovery.
 */
export async function discoveryVsRepeat(r: Range): Promise<DiscoverySplit[]> {
	return query<DiscoverySplit>(sql`
		with firsts as (
		  select st.canonical_track_id as cid, min(p.played_at) as first_heard -- sql-lint: internal
		    from plays p
		    join spotify_tracks st on st.id = p.track_id
		   where st.canonical_track_id is not null
		   group by 1
		)
		select to_char(date_trunc('month', p.played_at at time zone ${r.tz}), 'YYYY-MM') as period,
		       count(*) filter (
		         where date_trunc('month', p.played_at at time zone ${r.tz})
		             = date_trunc('month', f.first_heard at time zone ${r.tz})
		       )::int as "firstTime",
		       count(*) filter (
		         where date_trunc('month', p.played_at at time zone ${r.tz})
		            <> date_trunc('month', f.first_heard at time zone ${r.tz})
		       )::int as revisited
		  from plays p
		  join spotify_tracks st on st.id = p.track_id
		  join firsts f on f.cid = st.canonical_track_id
		 where ${win(r)}
		 group by 1 order by 1
	`);
}

export interface ListeningStreaks {
	longest: number;
	longestEnd: string | null;
	current: number;
	busiestDay: string | null;
	busiestMinutes: number;
}

export async function listeningStreaks(r: Range): Promise<ListeningStreaks> {
	const rows = await query<ListeningStreaks>(sql`
		with days as (
		  select (p.played_at at time zone ${r.tz})::date as d,
		         round(coalesce(sum(p.ms_played), 0) / 60000.0)::int as minutes
		    from plays p where ${win(r)} group by 1
		), grouped as (
		  -- Consecutive dates share (date - row_number): gaps and islands.
		  select d, minutes, d - (row_number() over (order by d))::int as grp from days
		), runs as (
		  select grp, count(*)::int as len, max(d) as ended from grouped group by grp
		), busiest as (
		  select d, minutes from days order by minutes desc, d desc limit 1
		)
		select coalesce((select max(len) from runs), 0) as longest,
		       (select to_char(ended, 'YYYY-MM-DD') from runs order by len desc, ended desc limit 1)
		         as "longestEnd",
		       coalesce((select len from runs
		                  where ended >= (current_date - 1) order by ended desc limit 1), 0)
		         as current,
		       (select to_char(d, 'YYYY-MM-DD') from busiest) as "busiestDay",
		       coalesce((select minutes from busiest), 0) as "busiestMinutes"
	`);
	return (
		rows[0] ?? {
			longest: 0,
			longestEnd: null,
			current: 0,
			busiestDay: null,
			busiestMinutes: 0
		}
	);
}

// ------------------------------------------------------------------ the log

export interface PlayRow {
	id: number;
	playedAt: string;
	msPlayed: number | null;
	itemKind: string;
	canonicalTrackId: string | null;
	title: string;
	artist: string | null;
	artistId: string | null;
	album: string | null;
	cover: string | null;
	platform: string | null;
	reasonEnd: string | null;
	shuffle: boolean | null;
	source: string;
	total: number;
}

/**
 * The log itself, newest first.
 *
 * Falls back to the export's own labels whenever the catalog cannot name the
 * item: a play of a track since pulled from Spotify still reads as what it
 * was, rather than as a blank row.
 */
export async function playLog(
	r: Range,
	opts: { limit: number; offset: number; q?: string }
): Promise<PlayRow[]> {
	const q = (opts.q ?? '').trim();
	const search = q
		? sql`and (coalesce(ct.title, p.track_name) ilike ${'%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%'}
		        or coalesce(ar.name, p.artist_name) ilike ${'%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%'})`
		: sql``;
	return query<PlayRow>(sql`
		select (count(*) over ())::int          as total,
		       p.id,
		       ${iso('p.played_at')}            as "playedAt",
		       p.ms_played                      as "msPlayed",
		       p.item_kind                      as "itemKind",
		       ct.id                            as "canonicalTrackId",
		       coalesce(ct.title, p.track_name, p.episode_name, '(unknown)') as title,
		       coalesce(ar.name, p.artist_name) as artist,
		       ar.id                            as "artistId",
		       coalesce(al.name, p.album_name, p.show_name) as album,
		       ${thumb('album_images', 'album_id', 'al.id')} as cover,
		       p.platform,
		       p.reason_end                     as "reasonEnd",
		       p.shuffle,
		       p.source
		  from plays p
		  left join spotify_tracks st on st.id = p.track_id
		  left join canonical_tracks ct on ct.id = st.canonical_track_id
		  left join albums al on al.id = ct.primary_album_id
		  left join artists ar on ar.id = ct.primary_artist_id
		 where ${win(r)} ${search}
		 order by p.played_at desc, p.id desc
		 limit ${opts.limit} offset ${opts.offset}
	`);
}

// ---------------------------------------------------------------- coverage

export interface HistoryCoverage {
	plays: number;
	resolved: number;
	pending: number;
	unresolvable: number;
	nonTrack: number;
	firstPlayed: string | null;
	lastPlayed: string | null;
	fromExport: number;
	fromApi: number;
	savedNeverPlayed: number;
}

/**
 * How complete the log is, and how much of it the catalog can speak for.
 *
 * Shown rather than hidden: every recording-level chart silently omits the
 * unresolved plays, and a number that quietly excludes 13% of the data should
 * say so on the page it appears on.
 */
export async function coverage(): Promise<HistoryCoverage> {
	const rows = await query<HistoryCoverage>(sql`
		select count(*)::int as plays,
		       count(*) filter (where p.track_id is not null)::int as resolved,
		       count(*) filter (
		         where p.track_id is null and p.item_kind = 'track'
		           and p.resolve_attempted_at is null)::int as pending,
		       count(*) filter (
		         where p.track_id is null and p.item_kind = 'track'
		           and p.resolve_attempted_at is not null)::int as unresolvable,
		       count(*) filter (where p.item_kind <> 'track')::int as "nonTrack",
		       count(*) filter (where p.source = 'extended')::int  as "fromExport",
		       count(*) filter (where p.source = 'recent')::int     as "fromApi",
		       ${iso('min(p.played_at)')} as "firstPlayed",
		       ${iso('max(p.played_at)')} as "lastPlayed",
		       (select count(*)::int from library_canonical lc
		         where not exists (select 1 from canonical_play_stats c
		                            where c.canonical_track_id = lc.canonical_track_id))
		                                   as "savedNeverPlayed"
		  from plays p
	`);
	return (
		rows[0] ?? {
			plays: 0,
			resolved: 0,
			pending: 0,
			unresolvable: 0,
			nonTrack: 0,
			firstPlayed: null,
			lastPlayed: null,
			fromExport: 0,
			fromApi: 0,
			savedNeverPlayed: 0
		}
	);
}
