import { sql } from 'drizzle-orm';
import { query } from '../db/index.ts';

/**
 * The schema handed to the MCP client is read out of the catalog rather than
 * written down here. A hand-maintained copy drifts the first time a migration
 * lands and nobody notices — the model just writes confident SQL against a
 * column that no longer exists.
 */

/** Not readable by the MCP role (db/sql/post/070); listing them invites errors. */
const HIDDEN = new Set(['auth_tokens', 'auth_states', 'external_tokens']);

/**
 * Tables in the order someone should meet them. Anything not named here still
 * appears, under "other" — a new table is never silently hidden.
 */
const SECTIONS: { title: string; tables: string[] }[] = [
	{
		title: 'Library — start here',
		tables: ['library_canonical', 'library_tracks', 'saved_tracks', 'saved_albums', 'followed_artists']
	},
	{
		title: 'Catalog — recordings, releases, people',
		tables: [
			'canonical_tracks',
			'canonical_track_artists',
			'spotify_tracks',
			'track_artists',
			'album_groups',
			'albums',
			'album_artists',
			'artists',
			'genres',
			'artist_genres',
			'album_genres',
			'canonical_overrides'
		]
	},
	{
		title: 'Listening history',
		tables: ['plays', 'canonical_play_stats', 'play_imports']
	},
	{
		title: 'MusicBrainz enrichment — genres, BPM, key, origins, labels',
		tables: [
			'isrc_recordings',
			'mb_recordings',
			'audio_features',
			'mb_tags',
			'mb_genres',
			'artist_musicbrainz',
			'mb_artists',
			'mb_recording_artists',
			'album_musicbrainz',
			'mb_releases',
			'mb_release_groups'
		]
	},
	{ title: 'Playlists', tables: ['playlists', 'playlist_tracks'] },
	{
		title: 'Operational — sync bookkeeping, rarely the answer to a question',
		tables: [
			'sync_runs',
			'sync_phases',
			'sync_events',
			'rate_limiter',
			'api_call_stats',
			'ingest_raw',
			'settings',
			'spotify_users',
			'enrich_stages',
			'external_limiters'
		]
	}
];

/** Cosmetic only: images are five identical tables nobody needs spelled out. */
const TERSE = /_images$/;

interface ColumnRow {
	tbl: string;
	kind: string;
	col: string;
	typ: string;
	required: boolean;
	dflt: string | null;
	generated: boolean;
}

interface ConstraintRow {
	tbl: string;
	kind: string;
	def: string;
}

interface Table {
	name: string;
	rows: number | null;
	columns: ColumnRow[];
	constraints: ConstraintRow[];
}

function quoteIdent(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Exact counts, not `pg_class.reltuples`.
 *
 * The estimate is whatever the last autovacuum left behind — it reported
 * canonical_tracks at 109k against an actual 63k, and a model shown that number
 * plans around a table that does not exist. Counting all of them costs ~300 ms,
 * paid once per cache window rather than per question.
 */
async function countRows(names: string[]): Promise<Map<string, number>> {
	if (names.length === 0) return new Map();
	const union = names
		.map((n) => `select ${quoteLiteral(n)} as tbl, count(*)::bigint as n from ${quoteIdent(n)}`)
		.join(' union all ');
	const rows = await query<{ tbl: string; n: number }>(sql.raw(union));
	return new Map(rows.map((r) => [r.tbl, r.n]));
}

/**
 * One catalog read serves the instructions, the inventory and describe_schema.
 * Short-lived so a migration applied mid-session shows up without a restart.
 */
let cache: { at: number; tables: Map<string, Table> } | null = null;
const CACHE_MS = 60_000;

async function readCatalog(): Promise<Map<string, Table>> {
	if (cache && Date.now() - cache.at < CACHE_MS) return cache.tables;

	const [columns, constraints] = await Promise.all([
		query<ColumnRow>(sql`
			select c.relname                             as tbl,
			       c.relkind::text                       as kind,
			       a.attname                             as col,
			       format_type(a.atttypid, a.atttypmod)  as typ,
			       a.attnotnull                          as required,
			       pg_get_expr(d.adbin, d.adrelid)       as dflt,
			       a.attgenerated <> ''                  as generated
			  from pg_class c
			  join pg_namespace n on n.oid = c.relnamespace
			  join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
			  left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
			 where n.nspname = 'public'
			   and c.relkind in ('r', 'p', 'v', 'm')
			 order by c.relname, a.attnum
		`),
		query<ConstraintRow>(sql`
			select c.conrelid::regclass::text as tbl,
			       c.contype::text            as kind,
			       pg_get_constraintdef(c.oid) as def
			  from pg_constraint c
			  join pg_class t on t.oid = c.conrelid
			  join pg_namespace n on n.oid = t.relnamespace
			 where n.nspname = 'public'
			   and c.contype in ('p', 'f', 'u', 'c')
			 order by c.conrelid::regclass::text, c.contype, c.conname
		`)
	]);

	const tables = new Map<string, Table>();
	for (const row of columns) {
		if (HIDDEN.has(row.tbl)) continue;
		let t = tables.get(row.tbl);
		if (!t) {
			t = { name: row.tbl, rows: null, columns: [], constraints: [] };
			tables.set(row.tbl, t);
		}
		t.columns.push(row);
	}
	for (const row of constraints) {
		tables.get(row.tbl)?.constraints.push(row);
	}

	// Ordinary tables only: a view's count is its query, which may be expensive.
	const counts = await countRows(
		[...tables.values()].filter((t) => 'rp'.includes(t.columns[0]!.kind)).map((t) => t.name)
	);
	for (const [name, n] of counts) tables.get(name)!.rows = n;

	cache = { at: Date.now(), tables };
	return tables;
}

function rowCount(n: number | null): string {
	return n === null ? 'view' : `${n.toLocaleString('en-US')} rows`;
}

function renderTable(t: Table): string {
	const lines = [`${t.name}  (${rowCount(t.rows)})`];

	if (TERSE.test(t.name)) {
		lines.push(`  ${t.columns.map((c) => c.col).join(', ')}`);
		return lines.join('\n');
	}

	const pad = Math.min(28, Math.max(...t.columns.map((c) => c.col.length)) + 2);
	for (const c of t.columns) {
		const notes: string[] = [];
		if (c.required) notes.push('not null');
		if (c.generated) notes.push('generated');
		else if (c.dflt && c.dflt.length <= 32 && !c.dflt.startsWith('nextval'))
			notes.push(`default ${c.dflt}`);
		lines.push(`  ${c.col.padEnd(pad)}${c.typ}${notes.length ? `  ${notes.join(', ')}` : ''}`);
	}

	// pg_get_constraintdef already reads as documentation ("FOREIGN KEY (x)
	// REFERENCES y(id)", "CHECK (album_type in (...))") — and the CHECKs are the
	// only place the allowed values of a text column are written down.
	for (const c of t.constraints) {
		lines.push(`  ${c.def.replace(/\s+/g, ' ')}`);
	}
	return lines.join('\n');
}

/**
 * The full schema, sectioned. ~15 KB, so it is a tool the client calls rather
 * than something stapled to every tool description.
 */
export async function describeSchema(only?: string): Promise<string> {
	const tables = await readCatalog();

	if (only) {
		const t = tables.get(only);
		if (!t) {
			const known = [...tables.keys()].sort().join(', ');
			return `No readable table named "${only}".\n\nTables: ${known}`;
		}
		return renderTable(t);
	}

	const placed = new Set<string>();
	const out: string[] = [];

	for (const section of SECTIONS) {
		const present = section.tables.filter((name) => tables.has(name));
		if (present.length === 0) continue;
		out.push(`## ${section.title}\n`);
		for (const name of present) {
			placed.add(name);
			out.push(renderTable(tables.get(name)!), '');
		}
	}

	const rest = [...tables.keys()].filter((n) => !placed.has(n)).sort();
	if (rest.length > 0) {
		out.push('## Other\n');
		for (const name of rest) out.push(renderTable(tables.get(name)!), '');
	}

	return out.join('\n').trimEnd();
}

/** One line per table: the map that goes in the server instructions. */
export async function tableInventory(): Promise<string> {
	const tables = await readCatalog();
	const width = Math.max(...[...tables.keys()].map((n) => n.length)) + 2;
	const lines: string[] = [];
	for (const section of SECTIONS) {
		const present = section.tables.filter((n) => tables.has(n));
		if (present.length === 0) continue;
		lines.push(`  ${section.title}:`);
		for (const name of present) {
			lines.push(`    ${name.padEnd(width)}${rowCount(tables.get(name)!.rows)}`);
		}
	}
	return lines.join('\n');
}

/** Which optional subsystems have actually landed, for the rules text. */
export async function features(): Promise<{
	plays: boolean;
	playStats: boolean;
	enrichment: boolean;
}> {
	const rows = await query<{ name: string }>(sql`
		select relname as name
		  from pg_class c
		  join pg_namespace n on n.oid = c.relnamespace
		 where n.nspname = 'public'
		   and c.relname in ('plays', 'canonical_play_stats', 'isrc_recordings')
	`);
	const present = new Set(rows.map((r) => r.name));

	// The enrichment tables exist from the migration onward but stay empty for
	// hours while the crawl runs. Telling a model about a table with nothing in
	// it just invites queries that return no rows, so the feature is "has data",
	// not "has table".
	const [{ n } = { n: 0 }] = present.has('isrc_recordings')
		? await query<{ n: number }>(
				sql`select count(*)::int as n from isrc_recordings where recording_mbid is not null`
			)
		: [];

	return {
		plays: present.has('plays'),
		playStats: present.has('canonical_play_stats'),
		enrichment: n > 0
	};
}
