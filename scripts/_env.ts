import fs from 'node:fs';
import path from 'node:path';

/**
 * Loads .env for standalone scripts and the Node worker. SvelteKit does this
 * itself via vite, but `bun scripts/*.ts` and `node worker/main.ts` do not.
 */
export function loadEnv(file = '.env'): void {
	const p = path.resolve(process.cwd(), file);
	if (!fs.existsSync(p)) return;
	for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
		const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
		if (!m) continue;
		const [, key, rawValue] = m;
		if (!key || process.env[key] !== undefined) continue;
		let value = rawValue ?? '';
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		process.env[key] = value;
	}
}

loadEnv();
