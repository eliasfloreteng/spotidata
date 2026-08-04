import { sql } from 'drizzle-orm';
import pg, { type QueryArrayResult } from 'pg';
import { appPool, query } from '../db/index.ts';
import { config } from '../config.ts';

/**
 * Runs a client-supplied statement.
 *
 * "Read-only" is enforced by Postgres, not by inspecting the SQL. A parser or a
 * regex allowlist is the wrong tool — it has to be right about every way of
 * writing a write, forever, and it is wrong the first time someone sends a CTE
 * with a DML branch. Instead:
 *
 *   BEGIN READ ONLY      rejects every write, including DDL and functions that
 *                        write, at the point of execution
 *   SET LOCAL ROLE       drops the app's ownership privileges for a role granted
 *                        SELECT and nothing else (db/sql/post/070_mcp_role.sql),
 *                        which also puts the OAuth tables out of reach
 *   statement_timeout    a cartesian join cannot hold a pool connection open
 *   ROLLBACK, always     nothing a query did to session state survives it
 */

export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 5_000;

/** OIDs are stable within a database; one lookup per process is plenty. */
let typeNames: Promise<Map<number, string>> | null = null;

function loadTypeNames(): Promise<Map<number, string>> {
	typeNames ??= query<{ oid: number; name: string }>(
		sql`select oid::int as oid, typname as name from pg_type`
	)
		.then((rows) => new Map(rows.map((r) => [r.oid, r.name])))
		.catch(() => new Map<number, string>());
	return typeNames;
}

/** Postgres identifiers are quoted, not interpolated, even for our own config. */
function quoteIdent(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

const { types: pgTypes } = pg;

const DATE = 1082;
const TIMESTAMP = 1114;
const TIME = 1083;
const TIMETZ = 1266;

/**
 * Zoneless date/time values cross to the client as the text Postgres wrote.
 *
 * node-postgres turns them into a JS Date at the *server process's* local
 * offset, and serialising that back out as an instant moves them: a
 * `date_trunc('year', … at time zone 'Europe/Stockholm')::date` bucket for 2026
 * came out as "2025-12-31T23:00:00.000Z", labelling a year's worth of listening
 * with the wrong year. `at time zone` returns exactly this type, and it is in
 * every correctly written query here (rule 7), so this is the common path and
 * not an edge case. `timestamptz` is left alone — it is an unambiguous instant,
 * and ISO-8601 UTC says so.
 */
const asWritten = {
	getTypeParser: ((oid: number, format?: unknown) =>
		oid === DATE || oid === TIMESTAMP || oid === TIME || oid === TIMETZ
			? (v: string) => v
			: pgTypes.getTypeParser(oid, format as never)) as never
};

function jsonSafe(value: unknown): unknown {
	if (value === undefined) return null;
	if (typeof value === 'bigint') return value.toString();
	if (value instanceof Date) return value.toISOString();
	if (Buffer.isBuffer(value)) return `\\x${value.toString('hex')}`;
	return value;
}

export class SqlError extends Error {
	constructor(readonly detail: string) {
		super(detail);
		this.name = 'SqlError';
	}
}

interface PgError extends Error {
	code?: string;
	position?: string;
	detail?: string;
	hint?: string;
	where?: string;
}

function explain(err: unknown, statement: string): string {
	const e = err as PgError;
	if (!e?.message) return String(err);

	if (e.code === '57014') {
		return `Query cancelled: it ran longer than the ${config.mcp.statementTimeoutMs} ms limit. Narrow it, or aggregate in SQL instead of returning rows.`;
	}
	if (e.code === '25006') {
		return `Cannot run a write: this endpoint executes every statement in a READ ONLY transaction as a role granted SELECT only. (${e.message})`;
	}
	if (e.code === '42501') {
		return `Permission denied. The MCP role can read the library tables but not the OAuth tables, and cannot write anything. (${e.message})`;
	}
	if (e.code === '42704' && /role .* does not exist/i.test(e.message)) {
		return `The read-only role is missing — run \`bun run db:sql\` to apply db/sql/post/070_mcp_role.sql. (${e.message})`;
	}

	const parts = [e.message];
	if (e.detail) parts.push(`DETAIL: ${e.detail}`);
	if (e.hint) parts.push(`HINT: ${e.hint}`);

	// A character offset is useless to a model; the line it lands on is not.
	const position = Number(e.position);
	if (Number.isFinite(position) && position > 0) {
		const upto = statement.slice(0, position);
		const line = upto.split('\n').length;
		const column = position - (upto.lastIndexOf('\n') + 1);
		parts.push(`at line ${line}, column ${column}: ${statement.split('\n')[line - 1]?.trim()}`);
	}
	return parts.join('\n');
}

export async function runReadOnly(statement: string, limit: number): Promise<string> {
	const capped = Math.min(Math.max(1, Math.trunc(limit)), MAX_LIMIT);
	const types = await loadTypeNames();
	const client = await appPool.connect();
	const started = performance.now();

	try {
		await client.query('begin read only');
		await client.query(`set local statement_timeout = ${config.mcp.statementTimeoutMs}`);
		await client.query(`set local role ${quoteIdent(config.mcp.role)}`);

		// rowMode 'array' keeps column order and survives duplicate names, which
		// `select a.*, b.*` produces constantly.
		const raw = await client.query({ text: statement, rowMode: 'array', types: asWritten });

		// Several statements in one string come back as an array of results; the
		// last one that returned columns is the one that was asked about.
		const results = (Array.isArray(raw) ? raw : [raw]) as QueryArrayResult<unknown[]>[];
		const result = [...results].reverse().find((r) => r.fields?.length > 0) ?? results.at(-1)!;
		const elapsedMs = Math.round(performance.now() - started);

		const rows = result.rows ?? [];
		const fields = result.fields ?? [];

		if (fields.length === 0) {
			return `${result.command ?? 'Statement'} affected ${result.rowCount ?? 0} row(s) in ${elapsedMs} ms. No rows returned.`;
		}

		// Duplicate column names would silently overwrite each other in an object.
		const seen = new Map<string, number>();
		const names = fields.map((f) => {
			const n = seen.get(f.name) ?? 0;
			seen.set(f.name, n + 1);
			return n === 0 ? f.name : `${f.name}_${n + 1}`;
		});

		const shown = rows.slice(0, capped);
		const header =
			`${rows.length.toLocaleString('en-US')} row(s) in ${elapsedMs} ms` +
			(rows.length > shown.length
				? ` — showing the first ${shown.length}. Aggregate in SQL or raise \`limit\` (max ${MAX_LIMIT}) to see more.`
				: '') +
			`\ncolumns: ${fields.map((f, i) => `${names[i]} ${types.get(f.dataTypeID) ?? f.dataTypeID}`).join(', ')}`;

		const body = shown.map((row) =>
			JSON.stringify(Object.fromEntries(row.map((v, i) => [names[i], jsonSafe(v)])))
		);

		return shown.length === 0 ? `${header}\n\n(no rows)` : `${header}\n\n${body.join('\n')}`;
	} catch (err) {
		throw new SqlError(explain(err, statement));
	} finally {
		// The transaction is aborted on error and untouched on success; either way
		// nothing it did — including SET LOCAL — outlives the rollback.
		await client.query('rollback').catch(() => {});
		client.release();
	}
}
