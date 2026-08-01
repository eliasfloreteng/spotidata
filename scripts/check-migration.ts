import fs from 'node:fs';
import path from 'node:path';

/**
 * Fails the build if a generated migration would touch Graphile Worker's
 * schema.
 *
 * Drizzle v1 changed `schemaFilter` to default to *all* schemas. With the
 * queue living in the same database, a stray `DROP SCHEMA graphile_worker`
 * would annihilate every queued job — including the ones mid-sync. The
 * drizzle.config.ts `schemaFilter` is the fix; this is the backstop that makes
 * a regression loud instead of catastrophic.
 *
 * `CREATE SCHEMA "graphile_worker"` is expected and allowed: the schema is
 * declared in the drizzle schema precisely so the generator adopts rather than
 * drops it.
 */
const dir = path.resolve(process.cwd(), 'db/migrations');
if (!fs.existsSync(dir)) process.exit(0);

const FORBIDDEN = [
	/DROP\s+SCHEMA/i,
	/DROP\s+TABLE\s+"?graphile_worker"?/i,
	/graphile_worker"?\."/i
];

const offenders: string[] = [];

function walk(p: string): void {
	for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
		const full = path.join(p, entry.name);
		if (entry.isDirectory()) {
			walk(full);
		} else if (entry.name.endsWith('.sql')) {
			const sql = fs.readFileSync(full, 'utf8');
			for (const re of FORBIDDEN) {
				if (re.test(sql)) {
					offenders.push(`${path.relative(process.cwd(), full)} matches ${re}`);
				}
			}
		}
	}
}

walk(dir);

if (offenders.length > 0) {
	console.error('\n✗ Migration guard failed — refusing to touch the job queue schema:\n');
	for (const o of offenders) console.error(`   ${o}`);
	console.error(
		'\nCheck `schemaFilter: [\'public\']` in drizzle.config.ts, then delete and regenerate.\n'
	);
	process.exit(1);
}

console.log('✓ migration guard: no destructive graphile_worker statements');
