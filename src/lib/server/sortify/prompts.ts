import type { CatalogPlaylist } from './catalog.ts';
import type { Candidate, PlaylistProfile, SongFeatures } from './engine.ts';
import { openRouterJson, refIndex } from './openrouter.ts';

/**
 * The language-model half of sorting. Four prompts, all through OpenRouter,
 * each a pure function from songs and playlists to verdicts — storing them is
 * the caller's business (`ai.ts`), which is what lets the recall test run the
 * same prompts against a held-out catalog without touching the cache.
 *
 * - card: the feed's quick suggestions, ten songs against the playlist names
 *   and a few artists each.
 * - songs → playlists: a page of songs against the whole catalog with the data
 *   matches as hints; the sort queue.
 * - playlist → songs: one playlist with many of its own songs, judging a list of
 *   candidates; filling one playlist.
 * - leftovers → new playlists: songs that fit nowhere, grouped.
 */

export interface Verdict {
	confidence: number;
	why: string;
}

const clampConfidence = (c: unknown) => Math.min(3, Math.max(1, typeof c === 'number' ? Math.round(c) : 1));

// --------------------------------------------------------------- lines

function mmss(ms: number): string {
	const s = Math.round(ms / 1000);
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function topGenres(song: SongFeatures, limit = 5): string[] {
	return [...song.genres.entries()]
		.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
		.slice(0, limit)
		.map(([g]) => g);
}

export function songLine(s: SongFeatures): string {
	const parts = [`"${s.title}" — ${s.artistNames.slice(0, 3).filter(Boolean).join(', ')}`];
	parts.push(s.year !== null ? String(s.year) : '?');
	parts.push(mmss(s.durationMs));
	const genres = topGenres(s);
	if (genres.length > 0) parts.push(genres.join(', '));
	if (s.bpm !== null) parts.push(`${s.bpm} bpm`);
	if (s.popularity !== null) parts.push(`pop ${s.popularity}`);
	if (s.firstHeardYear !== null) parts.push(`first heard ${s.firstHeardYear}`);
	return parts.join(' | ');
}

export function playlistBlock(p: PlaylistProfile, ref: string, samples = 6): string {
	let head = `${ref} "${p.name}" — ${p.size} songs`;
	if (p.years) head += ` · ${p.years[0]}–${p.years[1]}`;
	if (p.firstHeard) head += ` · first heard ${p.firstHeard[0]}–${p.firstHeard[1]}`;
	if (p.popularity !== null) head += ` · median pop ${p.popularity}`;
	if (p.topGenres.length > 0) head += ` · ${p.topGenres.slice(0, 5).join(', ')}`;
	const lines = [head];
	if (p.description) lines.push(`  about: ${p.description.slice(0, 140)}`);
	if (p.topArtists.length > 0) lines.push(`  artists: ${p.topArtists.join(', ')}`);
	for (const s of p.samples.slice(0, samples)) {
		lines.push(`  · ${s.title} — ${s.artists} (${s.year ?? '?'})`);
	}
	return lines.join('\n');
}

/** The whole catalog, as the songs → playlists prompt starts. */
export function catalogText(profiles: PlaylistProfile[]): string {
	return profiles.map((p, i) => playlistBlock(p, `P${i}`)).join('\n');
}

const FIELDS =
	'release year | length | the artists\' genres | bpm | popularity (0–100, Spotify) | the year the person first played it';

// ------------------------------------------------------- songs → playlists

const SONGS_SYSTEM = `You sort a person's songs into their own Spotify playlists. Each playlist has a theme you must infer from its \
name, its songs, era, genres and artists. Themes can be a genre, an era ("70-90-tal" = songs released 1970–1999), \
a language or country ("Svidish" = Swedish), a mood, an activity, a setting, or the person's gut feel — judge by \
how well the song would sit next to the listed songs, not by genre tags alone. Swedish names are common \
(e.g. "Långa låtar" = long songs, "Nostalgi" = songs from their youth, "Tagg" = hyped).

Each song line has: ${FIELDS}. A playlist line has the same figures as ranges over its songs \
(5th–95th percentile), so they show what the playlist really holds. "closest by data" lists the playlists that \
match on artists and genres; use it as a hint, not an answer.

For each song, pick the playlists it clearly belongs in, best first. A song may fit several. Rate each pick: \
3 = belongs there without doubt, 2 = good fit, 1 = plausible. Use 3 sparingly — only when the song is an obvious \
example of what the playlist holds; event playlists (a party, a trip, an exam) rarely get one. Pick nothing \
rather than a weak fit. Never pick a \
playlist whose era, language or other hard rule the song breaks. Give each pick a reason of at most 6 words.
If no playlist is a 2 or 3, suggest one short new playlist name (1–4 words, in the person's naming style) that \
this song and similar ones would form; otherwise leave "new" out. Reply with JSON only.`;

export interface SongsAnswer {
	fits: Map<string, Map<string, Verdict>>;
	ideas: Map<string, string>;
}

export interface Catalog {
	text: string;
	ids: string[];
}

/** One request for a page of songs against the whole catalog. */
export async function askSongs(
	batch: Candidate[],
	catalog: Catalog,
	profiles: PlaylistProfile[],
	model: string
): Promise<SongsAnswer> {
	const refs = new Map(catalog.ids.map((id, i) => [id, `P${i}`]));
	const songs = batch
		.map((c, i) => {
			let line = `S${i}: ${songLine(c.features)}`;
			const hints = c.fits
				.slice(0, 5)
				.map((f) => {
					const ref = refs.get(f.playlistId);
					if (!ref) return null;
					return f.reasons.length === 0 ? ref : `${ref} (${f.reasons.join(', ')})`;
				})
				.filter((h): h is string => h !== null);
			if (hints.length > 0) line += `\n   closest by data: ${hints.join(', ')}`;
			const already = c.inPlaylists.map((id) => refs.get(id)).filter(Boolean);
			if (already.length > 0) line += `\n   already in: ${already.join(', ')}`;
			return line;
		})
		.join('\n');
	const user = `PLAYLISTS
${catalog.text}

SONGS
${songs}

Return {"songs":[{"s":0,"fits":[{"p":12,"c":3,"why":"max 6 words"}],"new":"name"}]} with one entry per song.`;

	type Reply = { songs?: Array<{ s?: unknown; fits?: Array<{ p?: unknown; c?: unknown; why?: string }>; new?: string }> };
	const reply = await openRouterJson<Reply>({
		kind: 'songs',
		model,
		system: SONGS_SYSTEM,
		user,
		items: batch.length
	});

	const existing = new Set(profiles.map((p) => p.name.toLowerCase()));
	const out: SongsAnswer = { fits: new Map(), ideas: new Map() };
	for (const song of reply.songs ?? []) {
		const i = refIndex(song.s);
		const c = i !== null ? batch[i] : undefined;
		if (!c) continue;
		const fits = out.fits.get(c.song) ?? new Map<string, Verdict>();
		for (const f of song.fits ?? []) {
			const p = refIndex(f.p);
			const id = p !== null ? catalog.ids[p] : undefined;
			if (id) fits.set(id, { confidence: clampConfidence(f.c), why: f.why ?? '' });
		}
		out.fits.set(c.song, fits);
		const idea = song.new?.trim();
		if (idea && !existing.has(idea.toLowerCase())) out.ideas.set(c.song, idea);
	}
	return out;
}

// ------------------------------------------------------- playlist → songs

const PLAYLIST_SYSTEM = `You decide which songs belong in one of a person's Spotify playlists. Infer what the playlist is about from its \
name, description and songs — it may be a genre, an era, a language, a mood, a setting or plain gut feel — and \
judge each candidate by how naturally it would sit next to those songs. Respect hard rules the name or songs \
imply (an era, a language, song length). Song lines give: ${FIELDS}.

Rate the songs that fit: 3 = belongs there without doubt, 2 = good fit, 1 = plausible, each with a reason of at \
most 6 words. Leave out every song that doesn't fit. Reply with JSON only.`;

/** The verdicts for the songs that fit; a song left out of the map was judged and left out. */
export async function judgePlaylist(
	profile: PlaylistProfile,
	batch: Candidate[],
	model: string
): Promise<Map<string, Verdict>> {
	const songs = batch.map((c, i) => `S${i}: ${songLine(c.features)}`).join('\n');
	const user = `${playlistBlock(profile, 'PLAYLIST', 24)}

CANDIDATES
${songs}

Return {"songs":[{"s":0,"c":3,"why":"max 6 words"}]} listing only the songs that fit.`;

	type Reply = { songs?: Array<{ s?: unknown; c?: unknown; why?: string }> };
	const reply = await openRouterJson<Reply>({
		kind: 'playlist',
		model,
		system: PLAYLIST_SYSTEM,
		user,
		items: batch.length
	});
	const out = new Map<string, Verdict>();
	for (const song of reply.songs ?? []) {
		const i = refIndex(song.s);
		const c = i !== null ? batch[i] : undefined;
		if (c) out.set(c.song, { confidence: clampConfidence(song.c), why: song.why ?? '' });
	}
	return out;
}

// ------------------------------------------------------- leftovers → new playlists

const IDEAS_SYSTEM = `You help a person organise their music. These songs don't fit any of their existing playlists. Propose new \
playlists that would group them well: each a coherent theme a person would actually put on (a genre, scene, era, \
mood, setting or vibe), named in the person's style — short, Swedish or English, sometimes playful; the existing \
names show the style. Only propose a playlist at least 6 of the songs fit; a song may go in more than one; songs \
that fit nothing stay out. Never duplicate an existing playlist. Song lines give: ${FIELDS}. Reply with JSON only.`;

export interface ProposedPlaylist {
	name: string;
	description: string;
	songKeys: string[];
}

export async function proposePlaylists(
	batch: Candidate[],
	profiles: PlaylistProfile[],
	taken: Set<string>,
	model: string
): Promise<ProposedPlaylist[]> {
	const existing = profiles.map((p) => `"${p.name}" (${p.size})`).join(', ');
	const songs = batch.map((c, i) => `S${i}: ${songLine(c.features)}`).join('\n');
	const user = `EXISTING PLAYLISTS: ${existing}

SONGS
${songs}

Return {"playlists":[{"name":"…","description":"one sentence","songs":[0,4,9]}]} with 4–8 playlists, best first.`;

	type Reply = { playlists?: Array<{ name?: string; description?: string; songs?: unknown[] }> };
	const reply = await openRouterJson<Reply>({
		kind: 'ideas',
		model,
		system: IDEAS_SYSTEM,
		user,
		items: batch.length,
		reasoning: { effort: 'low' },
		timeoutMs: 180_000
	});
	const out: ProposedPlaylist[] = [];
	for (const idea of reply.playlists ?? []) {
		const name = idea.name?.trim() ?? '';
		const seen = new Set<string>();
		const keys = (idea.songs ?? [])
			.map(refIndex)
			.map((i) => (i !== null ? batch[i]?.song : undefined))
			.filter((k): k is string => k !== undefined && !seen.has(k) && Boolean(seen.add(k)));
		if (!name || taken.has(name.toLowerCase()) || keys.length < 3) continue;
		taken.add(name.toLowerCase());
		out.push({ name, description: idea.description?.trim() ?? '', songKeys: keys });
	}
	return out;
}

// ------------------------------------------------------- the feed card

const CARD_SYSTEM = `You help a user sort songs into their Spotify playlists. Playlists can be about genre, mood, vibe, era, \
activity, or something arbitrary — infer each playlist's theme from its name, description and example artists. \
For each song, pick up to 3 existing playlists that fit well (best first; fewer is fine, empty if none fit), \
and propose 2 short new playlist ideas (1-4 words, in the user's naming style and language) that would fit \
this song and plausibly many others. Never propose an idea that duplicates an existing playlist. \
Avoid date/month-named and numbered DJ-set playlists unless clearly fitting. Answer only with JSON.`;

export interface CardSong {
	id: string;
	name: string;
	artists: string;
	album: string;
	year: string | null;
	genres: string[];
}

export interface CardPlaylist extends Pick<CatalogPlaylist, 'id' | 'name' | 'description' | 'total'> {
	topArtists: string[];
}

export interface CardSuggestion {
	playlists: string[];
	ideas: string[];
}

export async function suggestForCards(
	batch: CardSong[],
	catalog: CardPlaylist[],
	model: string
): Promise<Map<string, CardSuggestion>> {
	const catalogText = catalog
		.map((p, i) => {
			let line = `P${i}: ${p.name}`;
			const d = p.description.trim();
			if (d) line += ` — ${d.slice(0, 80)}`;
			line += ` [${p.total}]`;
			if (p.topArtists.length > 0) line += ` e.g. ${p.topArtists.join(', ')}`;
			return line;
		})
		.join('\n');
	const songsText = batch
		.map(
			(t, i) =>
				`S${i}: "${t.name}" — ${t.artists} | album "${t.album}" (${t.year ?? '?'}) | genres: ${
					t.genres.length === 0 ? '?' : t.genres.slice(0, 5).join(', ')
				}`
		)
		.join('\n');
	const user = `PLAYLISTS:
${catalogText}

SONGS:
${songsText}

Return {"songs":[{"s":0,"existing":["P12","P3"],"new":["idea","idea"]}, ...]} with one entry per song.`;

	type Reply = { songs?: Array<{ s?: unknown; existing?: unknown[]; new?: string[] }> };
	const reply = await openRouterJson<Reply>({
		kind: 'card',
		model,
		system: CARD_SYSTEM,
		user,
		items: batch.length,
		reasoning: { effort: 'minimal' },
		timeoutMs: 60_000
	});

	const names = new Set(catalog.map((p) => p.name.toLowerCase()));
	const out = new Map<string, CardSuggestion>();
	for (const song of reply.songs ?? []) {
		const i = refIndex(song.s);
		const t = i !== null ? batch[i] : undefined;
		if (!t) continue;
		const playlists = (song.existing ?? [])
			.map(refIndex)
			.map((j) => (j !== null ? catalog[j]?.id : undefined))
			.filter((id): id is string => id !== undefined);
		const ideas = (song.new ?? []).map((n) => n.trim()).filter((n) => n && !names.has(n.toLowerCase()));
		out.set(t.id, { playlists, ideas });
	}
	// A song the model skipped gets an empty answer, so it is not retried forever.
	for (const t of batch) if (!out.has(t.id)) out.set(t.id, { playlists: [], ideas: [] });
	return out;
}
