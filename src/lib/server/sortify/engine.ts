import { sql } from 'drizzle-orm';
import { query } from '../db/index.ts';
import { eligiblePlaylists, type CatalogPlaylist } from './catalog.ts';
import { currentVersion } from './version.ts';

/**
 * The objective half of sorting: what a song is, what each playlist holds, how
 * well the two match on hard data alone, and which songs most deserve sorting.
 *
 * Everything is built in one pass over the mirror into plain values (a
 * "snapshot") and kept in memory, because a sort page asks a dozen questions
 * of the same snapshot and the build is the expensive part. It is rebuilt when
 * Sortify's own writes move `version.ts`, when a sync has landed since, or after
 * a quarter of an hour regardless.
 *
 * The signals are what this archive knows about every song: the credited
 * artists, the original release year, the year the user first played it, and
 * the artists' Spotify genres — Spotify's only genre data, on the artist and
 * not the track. Genres are TF-IDF weighted across the library, so "pop" counts
 * for less than "italo disco".
 */

export interface SongFeatures {
	recording: string;
	song: string;
	title: string;
	/** Credited artists, the representative copy's first. */
	artistIds: string[];
	artistNames: string[];
	/** Genre → weight: the primary artist's genres strongest, a featured artist's weaker. */
	genres: Map<string, number>;
	year: number | null;
	durationMs: number;
	bpm: number | null;
	popularity: number | null;
	/** Completed plays, past 30 s. */
	plays: number;
	skips: number;
	firstHeardYear: number | null;
	/** Epoch ms of the last play's day. */
	lastPlayed: number | null;
}

export interface PlaylistProfile {
	id: string;
	name: string;
	description: string;
	size: number;
	artistCounts: Map<string, number>;
	topArtists: string[];
	genreVector: Map<string, number>;
	genreNorm: number;
	topGenres: string[];
	/** 5th–95th percentile of release years, once there are enough songs to say. */
	years: [number, number] | null;
	/** The years read as a rule (an era playlist), not just what happens to be there. */
	isEra: boolean;
	firstHeard: [number, number] | null;
	popularity: number | null;
	songKeys: Set<string>;
	recordings: Set<string>;
	samples: Array<{ title: string; artists: string; year: number | null }>;
	/** Name words that may name a genre ("disco"), for playlists too new to have a profile. */
	nameTokens: string[];
}

export interface ObjectiveFit {
	playlistId: string;
	score: number;
	/** Short and human: "3× Weezer", "1972–1998". */
	reasons: string[];
}

export interface Candidate {
	song: string;
	features: SongFeatures;
	/** The copy to add and to play: the most recently liked one. */
	trackId: string;
	/** Eligible playlists already holding this song. */
	inPlaylists: string[];
	/** Higher means more listened to and more left out. */
	priority: number;
	fits: ObjectiveFit[];
}

export interface Snapshot {
	profiles: PlaylistProfile[];
	profileById: Map<string, PlaylistProfile>;
	/** Every liked song played at least once, best first; filter by plays for a threshold. */
	candidates: Candidate[];
	candidateBySong: Map<string, Candidate>;
	/** Owned playlist → recordings, for "is this song already there" outside the eligible set. */
	ownedMembers: Map<string, Set<string>>;
	weights: GenreWeights;
	builtAt: number;
}

export interface EngineOptions {
	/** Use Spotify's artist genres at all. Off only to measure what they add. */
	genres: boolean;
}

export const DEFAULT_ENGINE: EngineOptions = { genres: true };

// ------------------------------------------------------------- the data

export interface LibraryData {
	recordings: Map<string, SongFeatures>;
	/** Liked songs, newest first. */
	liked: Array<{ trackId: string; recording: string }>;
	/** Owned playlist → its recordings in playlist order. */
	members: Map<string, string[]>;
	playlists: CatalogPlaylist[];
	artistGenres: Map<string, string[]>;
}

interface RecordingRow {
	id: string;
	song: string;
	title: string;
	year: number | null;
	popularity: number | null;
	bpm: number | null;
	plays: number;
	skips: number;
	first_heard: number | null;
	last_played: string | null;
	duration_ms: number;
	artists: string[] | null;
}

export async function loadLibrary(options: EngineOptions = DEFAULT_ENGINE): Promise<LibraryData> {
	const [recordingRows, artistRows, likedRows, memberRows, playlists] = await Promise.all([
		query<RecordingRow>(sql`
			select ct.id,
			       spotidata.sortify_song_key(ct.title, ct.id, ct.primary_artist_id) as song,
			       ct.title,
			       extract(year from ct.earliest_release_date)::int as year,
			       ct.max_popularity::int as popularity,
			       round(ta.bpm)::int as bpm,
			       coalesce(cps.completed_plays, 0)::int as plays,
			       coalesce(cps.skips, 0)::int as skips,
			       extract(year from cps.first_played_at at time zone 'UTC')::int as first_heard,
			       to_char(cps.last_played_at at time zone 'UTC', 'YYYY-MM-DD') as last_played,
			       ct.duration_ms,
			       (select array_agg(cta.artist_id order by cta.on_representative desc, cta.position)
			          from canonical_track_artists cta
			         where cta.canonical_track_id = ct.id) as artists
			  from library_canonical lc
			  join canonical_tracks ct on ct.id = lc.canonical_track_id
			  left join track_analysis ta on ta.isrc = ct.isrc and ta.status = 'ok'
			  left join canonical_play_stats cps on cps.canonical_track_id = ct.id
		`),
		query<{ id: string; name: string; genres: string[] | null }>(sql`
			select a.id, a.name,
			       (select array_agg(ag.genre order by ag.genre) from artist_genres ag where ag.artist_id = a.id) as genres
			  from artists a
			 where a.id in (
			   select cta.artist_id
			     from canonical_track_artists cta
			     join library_canonical lc on lc.canonical_track_id = cta.canonical_track_id)
		`),
		query<{ track_id: string; recording: string }>(sql`
			select s.track_id, st.canonical_track_id as recording
			  from saved_tracks s
			  join spotify_tracks st on st.id = s.track_id
			 where s.removed_at is null and st.canonical_track_id is not null
			 order by s.added_at desc, s.track_id
		`),
		query<{ playlist_id: string; recording: string }>(sql`
			select pt.playlist_id, st.canonical_track_id as recording
			  from playlist_tracks pt
			  join playlists p on p.id = pt.playlist_id and p.is_owned and p.removed_at is null
			  join spotify_tracks st on st.id = pt.track_id
			 where st.canonical_track_id is not null
			 order by pt.playlist_id, pt.position
		`),
		eligiblePlaylists()
	]);

	const names = new Map<string, string>();
	const artistGenres = new Map<string, string[]>();
	for (const a of artistRows) {
		names.set(a.id, a.name);
		artistGenres.set(a.id, options.genres ? (a.genres ?? []) : []);
	}

	const recordings = new Map<string, SongFeatures>();
	for (const r of recordingRows) {
		const ids = r.artists ?? [];
		const genres = new Map<string, number>();
		ids.slice(0, 2).forEach((id, i) => {
			for (const g of artistGenres.get(id) ?? []) {
				genres.set(g, Math.max(genres.get(g) ?? 0, i === 0 ? 0.6 : 0.3));
			}
		});
		recordings.set(r.id, {
			recording: r.id,
			song: r.song,
			title: r.title,
			artistIds: ids,
			artistNames: ids.map((id) => names.get(id) ?? ''),
			genres,
			year: r.year,
			durationMs: r.duration_ms,
			bpm: r.bpm,
			popularity: r.popularity,
			plays: r.plays,
			skips: r.skips,
			firstHeardYear: r.first_heard,
			lastPlayed: r.last_played ? Date.parse(`${r.last_played}T00:00:00Z`) : null
		});
	}

	const members = new Map<string, string[]>();
	for (const m of memberRows) {
		const list = members.get(m.playlist_id) ?? [];
		list.push(m.recording);
		members.set(m.playlist_id, list);
	}

	return {
		recordings,
		liked: likedRows.map((l) => ({ trackId: l.track_id, recording: l.recording })),
		members,
		playlists,
		artistGenres
	};
}

// ------------------------------------------------------------- genres

/** Inverse document frequency of each genre across the library's recordings. */
export class GenreWeights {
	readonly #idf = new Map<string, number>();
	readonly #fallback: number;

	constructor(recordings: Iterable<SongFeatures>) {
		const df = new Map<string, number>();
		let n = 0;
		for (const r of recordings) {
			n++;
			for (const g of r.genres.keys()) df.set(g, (df.get(g) ?? 0) + 1);
		}
		n = Math.max(n, 1);
		for (const [g, count] of df) this.#idf.set(g, Math.log(n / (1 + count)));
		this.#fallback = Math.log(n);
	}

	vector(song: SongFeatures): Map<string, number> {
		const v = new Map<string, number>();
		for (const [g, w] of song.genres) v.set(g, w * (this.#idf.get(g) ?? this.#fallback));
		return v;
	}
}

// ------------------------------------------------------------- profiles

const STOPWORDS = new Set([
	'the', 'and', 'och', 'med', 'music', 'songs', 'låtar', 'mix', 'playlist', 'elias', 'my', 'for'
]);

function nameTokens(name: string): string[] {
	return name
		.toLowerCase()
		.split(/[^\p{L}]+/u)
		.filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function range(values: number[], min: number, low: number, high: number): [number, number] | null {
	if (values.length < min) return null;
	const s = [...values].sort((a, b) => a - b);
	return [s[Math.floor((s.length - 1) * low)]!, s[Math.floor((s.length - 1) * high)]!];
}

const byCountThenName = <K extends string>(a: [K, number], b: [K, number]) =>
	b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

export function buildProfile(
	playlist: CatalogPlaylist,
	members: SongFeatures[],
	weights: GenreWeights
): PlaylistProfile {
	const seen = new Set<string>();
	const unique = members.filter((m) => !seen.has(m.song) && seen.add(m.song));

	const artistCounts = new Map<string, number>();
	const artistNames = new Map<string, string>();
	const vector = new Map<string, number>();
	const years: number[] = [];
	const heard: number[] = [];
	const pops: number[] = [];
	for (const m of unique) {
		[...new Set(m.artistIds)].slice(0, 4).forEach((a) => artistCounts.set(a, (artistCounts.get(a) ?? 0) + 1));
		m.artistIds.forEach((a, i) => artistNames.set(a, m.artistNames[i] ?? ''));
		for (const [g, w] of weights.vector(m)) vector.set(g, (vector.get(g) ?? 0) + w);
		if (m.year !== null) years.push(m.year);
		if (m.firstHeardYear !== null) heard.push(m.firstHeardYear);
		if (m.popularity !== null) pops.push(m.popularity);
	}

	const yearRange = range(years, 5, 0.05, 0.95);
	// The most played songs show the core and the latest additions where it is
	// heading; interleaved, so any prefix of the samples shows both.
	const byPlays = [...unique].sort((a, b) => b.plays - a.plays).slice(0, 12);
	const recent = [...unique].reverse().slice(0, 12);
	const sampled = new Set<string>();
	const samples: PlaylistProfile['samples'] = [];
	for (let i = 0; i < Math.min(byPlays.length, recent.length); i++) {
		for (const s of [byPlays[i]!, recent[i]!]) {
			if (sampled.has(s.song) || samples.length >= 24) continue;
			sampled.add(s.song);
			samples.push({ title: s.title, artists: s.artistNames.slice(0, 2).join(', '), year: s.year });
		}
	}

	return {
		id: playlist.id,
		name: playlist.name.trim(),
		description: playlist.description.trim(),
		size: unique.length,
		artistCounts,
		topArtists: [...artistCounts.entries()]
			.sort(byCountThenName)
			.slice(0, 5)
			.map(([a]) => artistNames.get(a) ?? '')
			.filter(Boolean),
		genreVector: vector,
		genreNorm: Math.sqrt([...vector.values()].reduce((s, w) => s + w * w, 0)),
		topGenres: [...vector.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([g]) => g),
		years: yearRange,
		isEra: yearRange !== null && yearRange[1] - yearRange[0] <= 30,
		firstHeard: range(heard, 5, 0.1, 0.9),
		popularity: pops.length >= 5 ? [...pops].sort((a, b) => a - b)[Math.floor(pops.length / 2)]! : null,
		songKeys: new Set(members.map((m) => m.song)),
		recordings: new Set(members.map((m) => m.recording)),
		samples,
		nameTokens: nameTokens(playlist.name)
	};
}

export const profileContains = (p: PlaylistProfile, s: SongFeatures) =>
	p.recordings.has(s.recording) || p.songKeys.has(s.song);

// ------------------------------------------------------------- fitting

/**
 * How well a song matches each playlist on hard data, best first; playlists
 * already holding it are skipped. Shared artists and genre similarity carry the
 * score; an era playlist adds or subtracts for the year; a name that reads like
 * one of the song's genres lifts a playlist too young to have a profile.
 */
export function fitsFor(song: SongFeatures, profiles: PlaylistProfile[], weights: GenreWeights): ObjectiveFit[] {
	const vector = weights.vector(song);
	const norm = Math.sqrt([...vector.values()].reduce((s, w) => s + w * w, 0));
	const words = new Set([...song.genres.keys()].flatMap((g) => g.split(/[^\p{L}]+/u).filter(Boolean)));
	const out: ObjectiveFit[] = [];
	for (const p of profiles) {
		if (profileContains(p, song)) continue;
		const reasons: string[] = [];

		let shared = 0;
		let sharedName = '';
		song.artistIds.forEach((a, i) => {
			const c = p.artistCounts.get(a) ?? 0;
			if (c > shared) {
				shared = c;
				sharedName = song.artistNames[i] ?? '';
			}
		});
		const artist = shared > 0 ? Math.min(1, 0.5 + shared / 6) : 0;
		if (shared > 0) reasons.push(sharedName ? `${shared}× ${sharedName}` : `${shared}× same artist`);

		let genre = 0;
		if (norm > 0 && p.genreNorm > 0) {
			let dot = 0;
			for (const [g, w] of vector) dot += w * (p.genreVector.get(g) ?? 0);
			genre = dot / (norm * p.genreNorm);
		}

		let era = 0;
		if (p.isEra && p.years && song.year !== null) {
			const [lo, hi] = p.years;
			const inside = song.year >= lo - 2 && song.year <= hi + 2;
			era = inside ? 0.15 : -0.3;
			reasons.push(inside ? `${lo}–${hi}` : `outside ${lo}–${hi}`);
		}

		let name = 0;
		if (p.nameTokens.some((t) => [...words].some((w) => w === t || (t.length >= 5 && w.startsWith(t))))) {
			name = p.size < 15 ? 0.35 : 0.1;
			if (p.size < 15) reasons.push('matches the name');
		}

		const score = 0.55 * genre + 0.45 * artist + era + name;
		if (score > 0.08) out.push({ playlistId: p.id, score, reasons });
	}
	return out.sort((a, b) => b.score - a.score);
}

// ------------------------------------------------------------- the snapshot

export interface BuildInput {
	data: LibraryData;
	/** Recordings to leave out of every profile — the held-out songs of a recall test. */
	holdOut?: Set<string>;
}

export function buildSnapshot({ data, holdOut }: BuildInput): Snapshot {
	const weights = new GenreWeights(data.recordings.values());
	const profiles = data.playlists.map((playlist) => {
		const members = (data.members.get(playlist.id) ?? [])
			.filter((r) => !holdOut?.has(r))
			.map((r) => data.recordings.get(r))
			.filter((m): m is SongFeatures => m !== undefined);
		return buildProfile(playlist, members, weights);
	});

	const ownedMembers = new Map<string, Set<string>>();
	for (const [id, recs] of data.members) ownedMembers.set(id, new Set(recs));

	// Liked songs newest first, so the representative copy of a song is the latest one liked.
	const groups = new Map<string, Array<{ trackId: string; features: SongFeatures }>>();
	for (const l of data.liked) {
		const features = data.recordings.get(l.recording);
		if (!features) continue;
		const list = groups.get(features.song) ?? [];
		list.push({ trackId: l.trackId, features });
		groups.set(features.song, list);
	}

	const now = Date.now();
	const candidates: Candidate[] = [];
	for (const [song, copies] of groups) {
		const rep = copies[0]!;
		const seen = new Set<string>();
		const distinct = copies.map((c) => c.features).filter((f) => !seen.has(f.recording) && seen.add(f.recording));
		const plays = distinct.reduce((s, f) => s + f.plays, 0);
		if (plays < 1) continue;
		const skips = distinct.reduce((s, f) => s + f.skips, 0);
		const lastPlayed = Math.max(...distinct.map((f) => f.lastPlayed ?? -Infinity));
		const holding = profiles.filter((p) => distinct.some((f) => profileContains(p, f)));

		const months = Number.isFinite(lastPlayed) ? (now - lastPlayed) / (30 * 86_400_000) : 36;
		const recency = 0.4 + 0.6 * Math.exp(-months / 24);
		const skipFactor = plays / (plays + 0.5 * skips);
		const care = Math.log2(1 + plays) * recency * skipFactor;
		const leftOut = [1, 0.3, 0.12, 0.05][Math.min(holding.length, 3)]!;

		const open = profiles.filter((p) => !distinct.some((f) => profileContains(p, f)));
		candidates.push({
			song,
			features: { ...rep.features, plays, skips },
			trackId: rep.trackId,
			inPlaylists: holding.map((p) => p.id),
			priority: care * leftOut,
			fits: fitsFor(rep.features, open, weights).slice(0, 16)
		});
	}
	candidates.sort((a, b) => b.priority - a.priority);

	return {
		profiles,
		profileById: new Map(profiles.map((p) => [p.id, p])),
		candidates,
		candidateBySong: new Map(candidates.map((c) => [c.song, c])),
		ownedMembers,
		weights,
		builtAt: now
	};
}

// ------------------------------------------------------------- caching

const MAX_AGE_MS = 15 * 60_000;
let cached: { snapshot: Snapshot; key: string } | null = null;
let building: Promise<Snapshot> | null = null;

/** Moves when a sync lands or the liked songs change behind Sortify's back. */
async function mirrorKey(): Promise<string> {
	const rows = await query<{ key: string }>(sql`
		select concat_ws('|',
		  (select max(finished_at)::text from sync_runs),
		  (select count(*) from saved_tracks where removed_at is null),
		  ${currentVersion()}::text) as key
	`);
	return rows[0]?.key ?? '';
}

export async function getSnapshot(): Promise<Snapshot> {
	const key = await mirrorKey();
	if (cached && cached.key === key && Date.now() - cached.snapshot.builtAt < MAX_AGE_MS) {
		return cached.snapshot;
	}
	building ??= (async () => {
		try {
			const snapshot = buildSnapshot({ data: await loadLibrary() });
			cached = { snapshot, key };
			return snapshot;
		} finally {
			building = null;
		}
	})();
	return building;
}
