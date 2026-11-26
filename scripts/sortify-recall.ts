import './_env.ts';
import { closePools } from '../src/lib/server/db/index.ts';
import { models, type AiState } from '../src/lib/server/sortify/ai.ts';
import { buildSnapshot, loadLibrary, type Candidate } from '../src/lib/server/sortify/engine.ts';
import { askSongs, catalogText, type Verdict } from '../src/lib/server/sortify/prompts.ts';
import { contextFrom, suggestionsFor } from '../src/lib/server/sortify/sort.ts';

/**
 * Sortify's held-out recall test: can a method find the playlists a song is
 * already in, once the song is taken out of them?
 *
 * 80 liked songs (played at least twice) that sit in at least one eligible
 * playlist are drawn with a fixed seed and removed from every playlist profile
 * at once. Each method then ranks playlists for them as the sort queue would,
 * and recall@3 is |top 3 ∩ the playlists the song was in| / min(3, that many),
 * averaged over the songs. A lower bound on quality: many "wrong" picks are
 * plausible playlists the song just is not in yet.
 *
 *   bun scripts/sortify-recall.ts            data only, with and without genres
 *   bun scripts/sortify-recall.ts --model    also the sort model with data hints (spends ~$0.01 a run)
 *   bun scripts/sortify-recall.ts --seed=7   another sample of 80
 *
 * Nothing is written: the model's verdicts are held in memory, never cached.
 */

const SAMPLE = 80;
const SEED = Number(process.argv.find((a) => a.startsWith('--seed='))?.slice(7) ?? 20261126);
const MIN_PLAYS = 2;
const PAGE = 8;
const withModel = process.argv.includes('--model');

function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const emptyAi = (): AiState => ({ fits: new Map(), asked: new Set(), ideas: new Map(), judged: new Map() });
const noDecisions = { reviewed: new Set<string>(), dismissed: new Set<string>() };

interface Result {
	recall: number;
	hit: number;
}

function score(picks: Map<string, string[]>, truth: Map<string, string[]>): Result {
	let recall = 0;
	let hit = 0;
	for (const [song, want] of truth) {
		const got = new Set((picks.get(song) ?? []).slice(0, 3));
		const hits = want.filter((p) => got.has(p)).length;
		recall += hits / Math.min(3, want.length);
		if (hits > 0) hit++;
	}
	return { recall: recall / truth.size, hit: hit / truth.size };
}

async function run(genres: boolean) {
	const data = await loadLibrary({ genres });
	const full = buildSnapshot({ data });
	const pool = full.candidates.filter((c) => c.features.plays >= MIN_PLAYS && c.inPlaylists.length > 0);
	const random = rng(SEED);
	const sample = [...pool]
		.map((c) => ({ c, r: random() }))
		.sort((a, b) => a.r - b.r)
		.slice(0, SAMPLE)
		.map(({ c }) => c);

	const songs = new Set(sample.map((c) => c.song));
	const holdOut = new Set([...data.recordings.values()].filter((r) => songs.has(r.song)).map((r) => r.recording));
	const truth = new Map(sample.map((c) => [c.song, c.inPlaylists]));

	const held = buildSnapshot({ data, holdOut });
	const candidates = sample.map((c) => held.candidateBySong.get(c.song)).filter((c): c is Candidate => !!c);

	const rank = (ai: AiState) => {
		const ctx = contextFrom(held, ai, noDecisions, MIN_PLAYS);
		return new Map(candidates.map((c) => [c.song, suggestionsFor(ctx, c, 3).map((s) => s.playlistId)]));
	};
	const raw = new Map(candidates.map((c) => [c.song, c.fits.slice(0, 3).map((f) => f.playlistId)]));
	const out: Record<string, Result> = {
		[`data${genres ? '' : ', no genres'} (as ranked in the app)`]: score(rank(emptyAi()), truth),
		[`data${genres ? '' : ', no genres'} (raw fits)`]: score(raw, truth)
	};

	if (withModel) {
		const { sortModel } = await models();
		const catalog = { text: catalogText(held.profiles), ids: held.profiles.map((p) => p.id) };
		const ai = emptyAi();
		for (let i = 0; i < candidates.length; i += PAGE) {
			const batch = candidates.slice(i, i + PAGE);
			const answer = await askSongs(batch, catalog, held.profiles, sortModel);
			for (const c of batch) {
				ai.asked.add(c.song);
				ai.fits.set(c.song, answer.fits.get(c.song) ?? new Map<string, Verdict>());
			}
		}
		out[`${sortModel} + data hints${genres ? '' : ', no genres'}`] = score(rank(ai), truth);
	}
	return { out, pool: pool.length, sampled: candidates.length, profiles: held.profiles.length };
}

for (const genres of [true, false]) {
	const { out, pool, sampled, profiles } = await run(genres);
	console.log(`\n${genres ? 'With' : 'Without'} Spotify artist genres — ${sampled} of ${pool} songs, ${profiles} playlists`);
	for (const [name, r] of Object.entries(out)) {
		console.log(`  ${name.padEnd(52)} recall@3 ${r.recall.toFixed(3)}   hit@3 ${r.hit.toFixed(3)}`);
	}
}
await closePools();
