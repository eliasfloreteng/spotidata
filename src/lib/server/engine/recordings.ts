import { sql, type SQL } from 'drizzle-orm';
import { db } from '../db/index.ts';

/**
 * What the music folder holds, from Deckhand's engine: `deckhand.recordings`,
 * one row per ISRC with the file that holds it and, once the engine has
 * analysed the file, its tempo, its key (as a Camelot code) and whose analysis
 * that is — rekordbox's, sent from the Mac, or rbxport's. The engine owns the
 * view (engine/server/migrations/), and picks the file of a recording held
 * twice the same way it does itself, so the two never disagree.
 *
 * Joined to `canonical_tracks` on the ISRC, upper-cased: the engine stores it so,
 * and Spotify hands out a few hundred in lower case. A recording without a
 * file has no tempo or key: they come from the real audio and nothing else.
 *
 * The schema is the engine's to create, so a database it has never started
 * against (a fresh dev setup) lacks it. Every query then reads an empty
 * stand-in with the same columns instead of failing.
 */
const EMPTY = sql.raw(`(select null::text as isrc, null::text as file, null::text as state,
	null::numeric as bpm, null::text as musical_key, null::text as camelot, null::text as analysis,
	null::bigint as size, null::timestamptz as first_seen where false)`);

let present = false;
let checkedAt = 0;

/** `deckhand.recordings`, or the stand-in until the engine has created it. */
export async function recordings(): Promise<SQL> {
	if (!present && Date.now() - checkedAt > 60_000) {
		checkedAt = Date.now();
		const { rows } = await db.execute<{ ok: boolean }>(
			sql`select to_regclass('deckhand.recordings') is not null as ok`
		);
		present = rows[0]?.ok ?? false;
	}
	return present ? sql`deckhand.recordings` : EMPTY;
}

/** Whose analysis a file's tempo and key are. */
export type AnalysisSource = 'rekordbox' | 'rbxport';
