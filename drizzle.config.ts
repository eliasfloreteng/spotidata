import { defineConfig } from 'drizzle-kit';

if (!process.env.DATABASE_URL) {
	// Loaded from .env by `bun --env-file` / vite; fail loudly rather than
	// silently generating against nothing.
	const fs = await import('node:fs');
	const env = fs.readFileSync('.env', 'utf8');
	for (const line of env.split('\n')) {
		const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
		if (m?.[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
	}
}

export default defineConfig({
	dialect: 'postgresql',
	schema: './src/lib/server/db/schema/index.ts',
	out: './db/migrations',
	dbCredentials: { url: process.env.DATABASE_URL! },
	// Drizzle v1 changed the default to *all* schemas. Without this, drizzle-kit
	// sees Graphile Worker's `graphile_worker` schema as unmanaged drift and
	// plans to drop it — taking the job queue with it.
	schemaFilter: ['public'],
	// No `casing` here — v1 moved it to the table builder (`snakeCase.table`).
	verbose: true,
	strict: true
});
