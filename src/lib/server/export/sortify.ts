import { sql } from 'drizzle-orm';
import { query } from '../db/index.ts';

/**
 * The library as Sortify (the iOS playlist sorter) needs it: one row per
 * recording with what the Spotify API cannot tell an app — how often it was
 * really played, when it was first heard, when it was *originally* released,
 * and its MusicBrainz genres and moods — plus the credited artists' genres and
 * country. Sortify owns the live playlist state itself; this is the feature
 * store it ranks and prompts with.
 *
 * Postgres builds the whole document, so it crosses into JS as one string and
 * is never parsed here. Keys are omitted rather than sent as null, which keeps
 * the payload near 3 MB for a 9k-recording library (and a fraction of that
 * gzipped).
 *
 * Fields per recording:
 * - `id` — the canonical id, with the ISRC upper-cased so it matches the
 *   `isrc:<ISRC>` key Sortify derives from a Spotify track on its own (a few
 *   hundred ISRCs are stored lower-case).
 * - `tracks` — every Spotify id of this recording in the library, which is how
 *   a track without an ISRC (or a copy Sortify has not seen) is matched.
 * - `song` — a key one level looser than the recording: the same title, by the
 *   same primary artist, once featured-artist credits and remaster / radio-edit
 *   / original-mix / extended-mix qualifiers are stripped. Two ISRCs of one
 *   song share it, so a playlist holding the 2011 remaster is not offered the
 *   original. Remixes, live and acoustic versions keep their own key
 *   (`spotidata.song_title_key`). An empty normalised title falls back to the
 *   recording id rather than fusing every untitled track of an artist.
 * - `year` — the earlier of Spotify's earliest release and MusicBrainz's first
 *   release, so a 2011 remaster of a 1973 song still says 1973.
 * - `plays` / `skips` — completed plays (past 30 s) and skips, from
 *   `canonical_play_stats`.
 * - `moods` — AcousticBrainz classifier labels scoring at least 0.85. They are
 *   evidence, not verdicts (rule 10), which is why only the confident ones go.
 */
export async function sortifyLibrary(): Promise<string> {
	const rows = await query<{ body: string }>(sql`
		with lib as (
		  select lc.canonical_track_id as id, ct.kind, ct.isrc, ct.title, ct.max_popularity,
		         lc.primary_artist_id,
		         least(ct.earliest_release_date, te.mb_first_release_date) as released,
		         te.bpm, te.danceable, te.happy, te.sad, te.relaxed, te.party,
		         te.aggressive, te.acoustic, te.electronic, te.instrumental
		    from library_canonical lc
		    join canonical_tracks ct on ct.id = lc.canonical_track_id
		    left join spotidata.track_enrichment te on te.canonical_track_id = lc.canonical_track_id
		), genres as (
		  -- Set-based rather than track_enrichment.genres, whose per-row function call
		  -- is most of the cost of reading 9k rows at once. Same genre test, same order.
		  select tg.canonical_track_id as id,
		         (array_agg(tg.genre order by tg.votes desc, tg.genre))[1:6] as names
		    from spotidata.track_genres tg
		   where tg.canonical_track_id in (select id from lib)
		   group by 1
		), ids as (
		  select st.canonical_track_id as id, array_agg(lt.track_id order by lt.track_id) as track_ids
		    from library_tracks lt
		    join spotify_tracks st on st.id = lt.track_id
		   group by 1
		), credits as (
		  select cta.canonical_track_id as id,
		         array_agg(cta.artist_id order by cta.on_representative desc, cta.position) as artist_ids
		    from canonical_track_artists cta
		   where cta.canonical_track_id in (select id from lib)
		   group by 1
		), songs as (
		  select lib.id, nullif(spotidata.song_title_key(lib.title), '') as title_key from lib
		), moods as (
		  select lib.id, array_remove(array[
		           case when lib.happy        >= 0.85 then 'happy' end,
		           case when lib.sad          >= 0.85 then 'sad' end,
		           case when lib.relaxed      >= 0.85 then 'relaxed' end,
		           case when lib.party        >= 0.85 then 'party' end,
		           case when lib.aggressive   >= 0.85 then 'aggressive' end,
		           case when lib.acoustic     >= 0.85 then 'acoustic' end,
		           case when lib.electronic   >= 0.85 then 'electronic' end,
		           case when lib.instrumental >= 0.85 then 'instrumental' end,
		           case when lib.danceable    >= 0.85 then 'danceable' end
		         ], null) as labels
		    from lib
		)
		select json_build_object(
		  'version', 1,
		  'generatedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
		  'recordings', coalesce((
		    select json_agg(json_strip_nulls(json_build_object(
		      'id', case when lib.kind = 'isrc' then 'isrc:' || upper(lib.isrc) else lib.id end,
		      'tracks', ids.track_ids,
		      'artists', credits.artist_ids,
		      'song', substr(md5(coalesce(songs.title_key, lib.id) || '|' || coalesce(lib.primary_artist_id, '')), 1, 16),
		      'plays', nullif(cps.completed_plays, 0),
		      'skips', nullif(cps.skips, 0),
		      'firstPlayed', to_char(cps.first_played_at at time zone 'UTC', 'YYYY-MM-DD'),
		      'lastPlayed', to_char(cps.last_played_at at time zone 'UTC', 'YYYY-MM-DD'),
		      'year', extract(year from lib.released)::int,
		      'popularity', lib.max_popularity,
		      'genres', genres.names,
		      'bpm', round(lib.bpm)::int,
		      'moods', nullif(moods.labels, '{}')
		    )))
		      from lib
		      join songs using (id)
		      join moods using (id)
		      left join genres using (id)
		      left join ids using (id)
		      left join credits using (id)
		      left join canonical_play_stats cps on cps.canonical_track_id = lib.id
		  ), '[]'),
		  'artists', coalesce((
		    select json_object_agg(a.id, json_strip_nulls(json_build_object(
		      'name', a.name,
		      'genres', (select array_agg(g order by g) from (
		                   select ag.genre as g from artist_genres ag where ag.artist_id = a.id
		                   union
		                   select unnest(ae.genres[1:5])) x),
		      'country', ae.country)))
		      from artists a
		      left join spotidata.artist_enrichment ae on ae.artist_id = a.id
		     where a.id in (select unnest(artist_ids) from credits)
		  ), '{}')
		)::text as body
	`);
	return rows[0]?.body ?? '{"version":1,"recordings":[],"artists":{}}';
}
