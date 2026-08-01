import fs from 'node:fs';
import path from 'node:path';

/**
 * Two conventions that fail silently rather than loudly, so they get a lint.
 *
 * 1. TIMEZONE — every date bucket must go through `AT TIME ZONE`. A bare
 *    date_trunc/::date buckets in UTC, putting late-evening local saves on the
 *    wrong day; the chart still renders, just wrong.
 *
 * 2. TIMESTAMPS AS TEXT — drizzle configures node-postgres to return
 *    timestamps as strings and maps them itself only in the query builder.
 *    Raw SQL selecting a timestamp without `::text` yields a string typed as
 *    Date, and `someDate <= thatString` is always false. This exact bug
 *    disabled the liked-songs early stop for a whole sync.
 */
const ROOTS = ['src/lib/server'];
const problems: string[] = [];

function walk(dir: string, fn: (file: string, text: string) => void): void {
	if (!fs.existsSync(dir)) return;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(full, fn);
		else if (entry.name.endsWith('.ts')) fn(full, fs.readFileSync(full, 'utf8'));
	}
}

for (const root of ROOTS) {
	walk(root, (file, text) => {
		const rel = path.relative(process.cwd(), file);

		const lines = text.split('\n');

		// Columns that are already `date`, not `timestamptz` — no zone applies.
		const DATE_COLUMNS = /(earliest_release_date|release_date_start|\brelease_date\b|\bbucket\b)/;

		// Only analytics bucket by calendar date; the queue's date_truncs are
		// operational (per-minute counters) and timezone-independent.
		if (rel.includes('stats/')) {
			lines.forEach((line, i) => {
				if (!/date_trunc\(|::date\b|extract\(\s*\w+\s+from/i.test(line)) return;
				if (DATE_COLUMNS.test(line)) return;
				const prev = lines[i - 1] ?? '';
				if (!/at time zone/i.test(line) && !/at time zone/i.test(prev)) {
					problems.push(`${rel}:${i + 1} date bucket without AT TIME ZONE`);
				}
			});
		}

		// A timestamp that crosses back into JS must be cast, or it arrives as a
		// string typed as Date and every comparison against it silently fails.
		// Values that stay inside SQL can opt out with `-- sql-lint: internal`.
		lines.forEach((line, i) => {
			const m = line.match(/\b(max|min)\((added_at|first_added_at|finished_at|played_at)\)/);
			if (!m) return;
			// `iso(...)` (entities/shared.ts) emits to_char(... AT TIME ZONE 'UTC'),
			// which is a stronger guarantee than ::text — accept it.
			if (/::text|::date|\biso\(|to_char\(|sql-lint: internal/.test(line)) return;
			problems.push(
				`${rel}:${i + 1} ${m[0]} without ::text — add the cast, or mark it "-- sql-lint: internal" if it never leaves SQL`
			);
		});
	});
}

if (problems.length > 0) {
	console.error('\n✗ SQL convention check failed:\n');
	for (const p of problems) console.error(`   ${p}`);
	console.error('');
	process.exit(1);
}
console.log('✓ SQL conventions: timezone-aware buckets, timestamps cast to text');
