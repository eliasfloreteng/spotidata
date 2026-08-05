import { sql } from 'drizzle-orm';
import { query } from '../db/index.ts';
import { iso, thumb, MS_LISTENED, type ArtistRef } from './shared.ts';

/**
 * Per-entity listening figures, for the recording, artist, album and playlist
 * pages. Each is a small indexed lookup rather than a scan: `plays` is indexed
 * on (track_id, played_at), and the recording-level rollup is already built.
 *
 * Every one of these returns null-ish zeros rather than null when nothing was
 * played, so a page can render "never played" without a special case.
 */

export interface PlaySummary {
	plays: number;
	completed: number;
	skips: number;
	msPlayed: number;
	firstPlayedAt: string | null;
	lastPlayedAt: string | null;
}

const EMPTY: PlaySummary = {
	plays: 0,
	completed: 0,
	skips: 0,
	msPlayed: 0,
	firstPlayedAt: null,
	lastPlayedAt: null
};

/** Reads the rollup — one primary-key lookup, no events touched. */
export async function trackPlaySummary(canonicalTrackId: string): Promise<PlaySummary> {
	const rows = await query<PlaySummary>(sql`
		select plays, completed_plays as completed, skips, ms_played as "msPlayed",
		       ${iso('first_played_at')} as "firstPlayedAt",
		       ${iso('last_played_at')}  as "lastPlayedAt"
		  from canonical_play_stats where canonical_track_id = ${canonicalTrackId}
	`);
	return rows[0] ?? EMPTY;
}

export interface MonthPlays {
	period: string;
	plays: number;
	minutes: number;
}

/** A recording's own listening history by month, gap-free from first to last play. */
export async function trackPlaysByMonth(
	canonicalTrackId: string,
	tz: string
): Promise<MonthPlays[]> {
	return query<MonthPlays>(sql`
		with bounds as (
		  select date_trunc('month', min(p.played_at) at time zone ${tz}) as lo,
		         date_trunc('month', max(p.played_at) at time zone ${tz}) as hi
		    from plays p
		    join spotify_tracks st on st.id = p.track_id
		   where st.canonical_track_id = ${canonicalTrackId}
		), months as (
		  select generate_series(lo, hi, interval '1 month') as m from bounds where lo is not null
		), played as (
		  select date_trunc('month', p.played_at at time zone ${tz}) as m,
		         count(*)::int as plays,
		         round(coalesce(sum(${MS_LISTENED}), 0) / 60000.0)::int as minutes
		    from plays p
		    join spotify_tracks st on st.id = p.track_id
		   where st.canonical_track_id = ${canonicalTrackId}
		   group by 1
		)
		select to_char(months.m, 'YYYY-MM') as period,
		       coalesce(played.plays, 0)   as plays,
		       coalesce(played.minutes, 0) as minutes
		  from months left join played using (m)
		 order by months.m
	`);
}

export interface RecentPlay {
	id: number;
	playedAt: string;
	msPlayed: number | null;
	/** True when `msPlayed` is inferred from the log's spacing, not reported. */
	estimated: boolean;
	platform: string | null;
	reasonStart: string | null;
	reasonEnd: string | null;
	shuffle: boolean | null;
	source: string;
}

export async function recentPlaysFor(
	canonicalTrackId: string,
	limit = 12
): Promise<RecentPlay[]> {
	return query<RecentPlay>(sql`
		select p.id,
		       ${iso('p.played_at')} as "playedAt",
		       ${MS_LISTENED}        as "msPlayed",
		       (p.ms_played is null and p.estimated_ms is not null) as estimated,
		       p.platform,
		       p.reason_start        as "reasonStart",
		       p.reason_end          as "reasonEnd",
		       p.shuffle,
		       p.source
		  from plays p
		  join spotify_tracks st on st.id = p.track_id
		 where st.canonical_track_id = ${canonicalTrackId}
		 order by p.played_at desc
		 limit ${limit}
	`);
}

/**
 * An artist's listening totals, summed over the rollup rather than the events.
 *
 * Every credited artist counts, guest verses included — the same rule the
 * artist page already uses for its track list, so the two agree.
 */
export async function artistPlaySummary(artistId: string): Promise<PlaySummary> {
	const rows = await query<PlaySummary>(sql`
		select coalesce(sum(c.plays), 0)::int           as plays,
		       coalesce(sum(c.completed_plays), 0)::int as completed,
		       coalesce(sum(c.skips), 0)::int           as skips,
		       coalesce(sum(c.ms_played), 0)::bigint    as "msPlayed",
		       ${iso('min(c.first_played_at)')}         as "firstPlayedAt",
		       ${iso('max(c.last_played_at)')}          as "lastPlayedAt"
		  from canonical_play_stats c
		  join canonical_track_artists cta
		    on cta.canonical_track_id = c.canonical_track_id and cta.on_representative
		 where cta.artist_id = ${artistId}
	`);
	return rows[0] ?? EMPTY;
}

export interface PlayedRecording {
	canonicalTrackId: string;
	title: string;
	plays: number;
	msPlayed: number;
	lastPlayedAt: string | null;
	inLibrary: boolean;
	cover: string | null;
	artists: ArtistRef[];
}

/** An artist's most-listened recordings, saved or not. */
export async function artistTopPlayed(artistId: string, limit = 10): Promise<PlayedRecording[]> {
	return query<PlayedRecording>(sql`
		select ct.id                    as "canonicalTrackId",
		       ct.title,
		       c.plays,
		       c.ms_played              as "msPlayed",
		       ${iso('c.last_played_at')} as "lastPlayedAt",
		       (lc.canonical_track_id is not null) as "inLibrary",
		       ${thumb('album_images', 'album_id', 'ct.primary_album_id')} as cover,
		       coalesce((
		         select jsonb_agg(jsonb_build_object('id', ar.id, 'name', ar.name)
		                          order by cta2.position)
		           from canonical_track_artists cta2
		           join artists ar on ar.id = cta2.artist_id
		          where cta2.canonical_track_id = ct.id and cta2.on_representative
		       ), '[]'::jsonb)          as artists
		  from canonical_play_stats c
		  join canonical_tracks ct on ct.id = c.canonical_track_id
		  join canonical_track_artists cta
		    on cta.canonical_track_id = ct.id and cta.on_representative
		  left join library_canonical lc on lc.canonical_track_id = ct.id
		 where cta.artist_id = ${artistId}
		 order by c.ms_played desc, c.plays desc, ct.title
		 limit ${limit}
	`);
}

/**
 * An album's listening totals.
 *
 * Counted over every track row that belongs to the album, so a recording
 * played from a single still credits the album it also appears on — the same
 * "do I listen to this record?" reading the completion panel uses.
 */
export async function albumPlaySummary(albumId: string): Promise<PlaySummary> {
	const rows = await query<PlaySummary>(sql`
		select coalesce(sum(c.plays), 0)::int           as plays,
		       coalesce(sum(c.completed_plays), 0)::int as completed,
		       coalesce(sum(c.skips), 0)::int           as skips,
		       coalesce(sum(c.ms_played), 0)::bigint    as "msPlayed",
		       ${iso('min(c.first_played_at)')}         as "firstPlayedAt",
		       ${iso('max(c.last_played_at)')}          as "lastPlayedAt"
		  from canonical_play_stats c
		 where c.canonical_track_id in (
		   select distinct st.canonical_track_id from spotify_tracks st
		    where st.album_id = ${albumId} and st.canonical_track_id is not null
		 )
	`);
	return rows[0] ?? EMPTY;
}

/** A playlist's listening totals, over the recordings it holds. */
export async function playlistPlaySummary(playlistId: string): Promise<PlaySummary> {
	const rows = await query<PlaySummary>(sql`
		select coalesce(sum(c.plays), 0)::int           as plays,
		       coalesce(sum(c.completed_plays), 0)::int as completed,
		       coalesce(sum(c.skips), 0)::int           as skips,
		       coalesce(sum(c.ms_played), 0)::bigint    as "msPlayed",
		       ${iso('min(c.first_played_at)')}         as "firstPlayedAt",
		       ${iso('max(c.last_played_at)')}          as "lastPlayedAt"
		  from canonical_play_stats c
		 where c.canonical_track_id in (
		   select distinct st.canonical_track_id
		     from playlist_tracks pt
		     join spotify_tracks st on st.id = pt.track_id
		    where pt.playlist_id = ${playlistId} and st.canonical_track_id is not null
		 )
	`);
	return rows[0] ?? EMPTY;
}
