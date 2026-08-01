import './_env.ts';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

/**
 * Applies the hand-written SQL in db/sql/<stage>/ in filename order.
 *
 * `pre` runs before drizzle migrations (extensions the generated DDL depends
 * on); `post` runs after (functions that reference the tables). Every file is
 * written to be idempotent — CREATE OR REPLACE / IF NOT EXISTS — so this is
 * safe to re-run at any time.
 */
const stage = (process.argv[2] ?? 'post') as 'pre' | 'post';

const dir = path.resolve(process.cwd(), 'db/sql', stage);
if (!fs.existsSync(dir)) {
	console.log(`[sql] no ${stage} directory, nothing to do`);
	process.exit(0);
}

const files = fs
	.readdirSync(dir)
	.filter((f) => f.endsWith('.sql'))
	.sort();

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
	for (const file of files) {
		const sql = fs.readFileSync(path.join(dir, file), 'utf8');
		process.stdout.write(`[sql:${stage}] ${file} … `);
		await client.query(sql);
		console.log('ok');
	}
	console.log(`[sql:${stage}] applied ${files.length} file(s)`);
} catch (err) {
	console.error(`\n[sql:${stage}] FAILED:`, err instanceof Error ? err.message : err);
	process.exitCode = 1;
} finally {
	await client.end();
}
