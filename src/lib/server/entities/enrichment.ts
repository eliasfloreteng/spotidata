import { sql } from 'drizzle-orm';
import { query } from '../db/index.ts';
import { iso } from './shared.ts';

/**
 * Reading the enrichment back out: one status view for the crawler's own page,
 * and one lookup per entity page.
 *
 * Everything comes from the `spotidata.*_enrichment` views, so the join path
 * (canonical track → ISRC → recording → analysis) lives in SQL and not in four
 * different callers.
 */

export interface StageCoverage {
	stage: string;
	/** Resolved here rather than in the page, which cannot import server code. */
	label: string;
	candidates: number;
	matched: number;
	missed: number;
	status: string | null;
	requests: number;
	lastError: string | null;
	lastRunAt: string | null;
}

const STAGE_LABELS: Record<string, string> = {
	genres: 'Genre vocabulary',
	recordings: 'Recordings (ISRC → MusicBrainz)',
	audio: 'BPM & key (AcousticBrainz)',
	artists: 'Artists',
	albums: 'Albums'
};

export async function getCoverage(): Promise<StageCoverage[]> {
	const rows = await query<Omit<StageCoverage, 'label'>>(sql`
		select c.stage,
		       c.candidates,
		       c.matched,
		       c.missed,
		       s.status,
		       coalesce(s.requests, 0)   as requests,
		       s.last_error              as "lastError",
		       ${iso('s.last_run_at')}   as "lastRunAt"
		  from spotidata.enrichment_coverage c
		  left join enrich_stages s on s.key = c.stage
		 order by case c.stage
		            when 'recordings' then 1
		            when 'audio' then 2
		            when 'artists' then 3
		            when 'albums' then 4
		            else 5 end
	`);
	return rows.map((r) => ({ ...r, label: STAGE_LABELS[r.stage] ?? r.stage }));
}

export interface EnrichmentTotals {
	recordings: number;
	analysed: number;
	artists: number;
	releases: number;
	genreTags: number;
	vocabulary: number;
	/** Distinct genres actually attached to something in this library. */
	genresInUse: number;
}

export async function getTotals(): Promise<EnrichmentTotals> {
	const rows = await query<EnrichmentTotals>(sql`
		select (select count(*)::int from mb_recordings)                       as recordings,
		       (select count(*)::int from audio_features where status = 'ok')  as analysed,
		       (select count(*)::int from mb_artists where detail_level = 'full') as artists,
		       (select count(*)::int from mb_releases)                         as releases,
		       (select count(*)::int from mb_tags)                             as "genreTags",
		       (select count(*)::int from mb_genres)                           as vocabulary,
		       (select count(distinct t.tag)::int
		          from mb_tags t
		          join mb_genres g on g.name = t.tag)                          as "genresInUse"
	`);
	return (
		rows[0] ?? {
			recordings: 0,
			analysed: 0,
			artists: 0,
			releases: 0,
			genreTags: 0,
			vocabulary: 0,
			genresInUse: 0
		}
	);
}

export interface LimiterView {
	service: string;
	blockedUntil: string | null;
	requestsTotal: number;
	refillPerSec: number;
}

export async function getLimiters(): Promise<LimiterView[]> {
	return query<LimiterView>(sql`
		select service,
		       ${iso('blocked_until')}  as "blockedUntil",
		       requests_total           as "requestsTotal",
		       refill_per_sec           as "refillPerSec"
		  from external_limiters
		 order by service
	`);
}

/** Queued enrichment work, which is how the page knows the chain is alive. */
export async function isChainQueued(): Promise<boolean> {
	const rows = await query<{ n: number }>(sql`
		select count(*)::int as n
		  from graphile_worker._private_jobs
		 where task_id = (select id from graphile_worker._private_tasks where identifier = 'enrich:tick')
	`);
	return (rows[0]?.n ?? 0) > 0;
}

/**
 * The most-used genres across the library, weighted by how much of it they
 * describe. Recording tags only: an artist's genres describe a career, and
 * mixing the two would let one prolific artist outvote a whole shelf.
 */
export interface GenreCount {
	genre: string;
	recordings: number;
	plays: number;
}

export async function getTopGenres(limit = 24): Promise<GenreCount[]> {
	return query<GenreCount>(sql`
		select t.tag                                   as genre,
		       count(distinct ct.id)::int              as recordings,
		       coalesce(sum(ps.plays), 0)::int         as plays
		  from canonical_tracks ct
		  join isrc_recordings ir on ir.isrc = ct.isrc and ir.recording_mbid is not null
		  join mb_tags t on t.entity_type = 'recording' and t.entity_mbid = ir.recording_mbid
		  join mb_genres g on g.name = t.tag
		  left join canonical_play_stats ps on ps.canonical_track_id = ct.id
		 group by t.tag
		 order by plays desc, recordings desc
		 limit ${limit}
	`);
}

// ------------------------------------------------------------ entity views

export interface TrackEnrichment {
	recordingMbid: string | null;
	mbTitle: string | null;
	mbLengthMs: number | null;
	mbFirstReleaseDate: string | null;
	mbDisambiguation: string | null;
	genres: string[] | null;
	bpm: number | null;
	keyKey: string | null;
	keyScale: string | null;
	keyStrength: number | null;
	danceable: number | null;
	happy: number | null;
	sad: number | null;
	party: number | null;
	relaxed: number | null;
	aggressive: number | null;
	acoustic: number | null;
	electronic: number | null;
	instrumental: number | null;
	bright: number | null;
	tonal: number | null;
	averageLoudness: number | null;
	replayGain: number | null;
	genreRosamerica: string | null;
	moodMirex: string | null;
}

export async function getTrackEnrichment(
	canonicalTrackId: string
): Promise<TrackEnrichment | null> {
	const rows = await query<TrackEnrichment>(sql`
		select recording_mbid            as "recordingMbid",
		       mb_title                  as "mbTitle",
		       mb_length_ms              as "mbLengthMs",
		       mb_first_release_date::text as "mbFirstReleaseDate",
		       mb_disambiguation         as "mbDisambiguation",
		       genres,
		       bpm,
		       key_key                   as "keyKey",
		       key_scale                 as "keyScale",
		       key_strength              as "keyStrength",
		       danceable, happy, sad, party, relaxed, aggressive,
		       acoustic, electronic, instrumental, bright, tonal,
		       average_loudness          as "averageLoudness",
		       replay_gain               as "replayGain",
		       genre_rosamerica          as "genreRosamerica",
		       mood_mirex                as "moodMirex"
		  from spotidata.track_enrichment
		 where canonical_track_id = ${canonicalTrackId}
		   and recording_mbid is not null
	`);
	return rows[0] ?? null;
}

export interface ArtistEnrichment {
	mbid: string | null;
	/** 'credit' came free with a recording; 'url' cost a lookup but is exact. */
	matchSource: 'url' | 'credit' | null;
	mbName: string | null;
	type: string | null;
	gender: string | null;
	country: string | null;
	areaName: string | null;
	beginAreaName: string | null;
	beginDate: string | null;
	endDate: string | null;
	ended: boolean | null;
	disambiguation: string | null;
	ratingValue: number | null;
	ratingVotes: number | null;
	genres: string[] | null;
}

export async function getArtistEnrichment(artistId: string): Promise<ArtistEnrichment | null> {
	const rows = await query<ArtistEnrichment>(sql`
		select mbid,
		       match_source     as "matchSource",
		       mb_name          as "mbName",
		       type,
		       gender,
		       country,
		       area_name        as "areaName",
		       begin_area_name  as "beginAreaName",
		       begin_date       as "beginDate",
		       end_date         as "endDate",
		       ended,
		       disambiguation,
		       rating_value     as "ratingValue",
		       rating_votes     as "ratingVotes",
		       genres
		  from spotidata.artist_enrichment
		 where artist_id = ${artistId} and mbid is not null
	`);
	return rows[0] ?? null;
}

export interface AlbumEnrichment {
	releaseMbid: string | null;
	mbTitle: string | null;
	releaseStatus: string | null;
	releaseDate: string | null;
	country: string | null;
	barcode: string | null;
	packaging: string | null;
	language: string | null;
	labelName: string | null;
	catalogNumber: string | null;
	releaseGroupMbid: string | null;
	primaryType: string | null;
	secondaryTypes: string[] | null;
	groupFirstReleaseDate: string | null;
	genres: string[] | null;
}

export async function getAlbumEnrichment(albumId: string): Promise<AlbumEnrichment | null> {
	const rows = await query<AlbumEnrichment>(sql`
		select release_mbid       as "releaseMbid",
		       mb_title           as "mbTitle",
		       release_status     as "releaseStatus",
		       release_date       as "releaseDate",
		       country,
		       barcode,
		       packaging,
		       language,
		       label_name         as "labelName",
		       catalog_number     as "catalogNumber",
		       release_group_mbid as "releaseGroupMbid",
		       primary_type       as "primaryType",
		       secondary_types    as "secondaryTypes",
		       group_first_release_date as "groupFirstReleaseDate",
		       genres
		  from spotidata.album_enrichment
		 where album_id = ${albumId} and release_mbid is not null
	`);
	return rows[0] ?? null;
}
