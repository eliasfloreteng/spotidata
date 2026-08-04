import { DEFAULT_LIMIT, MAX_LIMIT, runReadOnly, SqlError } from './query.ts';
import { businessRules, KEY_RULES, serverInstructions } from './rules.ts';
import { describeSchema } from './schema.ts';

/**
 * A Model Context Protocol server over Streamable HTTP, hand-rolled.
 *
 * The official SDK's transport wants Node's `req`/`res` objects, which
 * SvelteKit does not hand out — adapting it costs more than the protocol does.
 * Stateless is the whole of it: a POST carries one JSON-RPC message, the reply
 * is one JSON body, no session id and no SSE stream, because nothing here is
 * server-initiated.
 */

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
const PREFERRED_PROTOCOL = PROTOCOL_VERSIONS[0];

const SERVER_INFO = {
	name: 'spotidata',
	title: 'Spotidata — Spotify library',
	version: '0.1.0'
};

export interface JsonRpcMessage {
	jsonrpc?: string;
	id?: string | number | null;
	method?: string;
	params?: Record<string, unknown>;
}

type JsonRpcResponse =
	| { jsonrpc: '2.0'; id: string | number | null; result: unknown }
	| {
			jsonrpc: '2.0';
			id: string | number | null;
			error: { code: number; message: string; data?: unknown };
	  };

const readOnlyTool = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false
} as const;

function tools(timezone: string) {
	return [
		{
			name: 'query',
			title: 'Run read-only SQL',
			description: `Run a single read-only SQL statement against the Spotidata Postgres database (PostgreSQL 18) and get the rows back as JSON lines.

Everything runs in a READ ONLY transaction as a role granted SELECT and nothing else, so writes fail rather than needing to be avoided. Aggregate in SQL rather than pulling rows and counting them yourself; ${DEFAULT_LIMIT} rows come back by default and ${MAX_LIMIT.toLocaleString('en-US')} is the ceiling. Dates should be bucketed \`at time zone '${timezone}'\`.

${KEY_RULES}`,
			inputSchema: {
				type: 'object',
				properties: {
					sql: {
						type: 'string',
						description:
							'A SELECT (or WITH … SELECT) statement. Unqualified names resolve in the public schema.'
					},
					limit: {
						type: 'integer',
						description: `Maximum rows to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}). The query still runs in full; this caps what is printed.`,
						minimum: 1,
						maximum: MAX_LIMIT
					}
				},
				required: ['sql'],
				additionalProperties: false
			},
			annotations: { title: 'Run read-only SQL', ...readOnlyTool }
		},
		{
			name: 'describe_schema',
			title: 'Describe the database schema',
			description:
				'Tables, columns, types, keys and CHECK constraints, read live from the Postgres catalog. Call this before writing a query against a table you have not seen — the CHECK constraints are where the allowed values of the text columns (album_type, detail_level, kind, status…) are written down. Pass `table` for one table instead of all of them.',
			inputSchema: {
				type: 'object',
				properties: {
					table: {
						type: 'string',
						description: 'Restrict the output to a single table, e.g. "library_canonical".'
					}
				},
				additionalProperties: false
			},
			annotations: { title: 'Describe the database schema', ...readOnlyTool }
		},
		{
			name: 'get_business_rules',
			title: 'Domain rules for this database',
			description:
				'How to read this data correctly: what counts as a track, what counts as the library, which tables are derived, how dates and soft deletes work. Same text as the server instructions — call it if those were not shown to you, or to re-read a rule before a query you are unsure about.',
			annotations: { title: 'Domain rules for this database', ...readOnlyTool },
			inputSchema: { type: 'object', properties: {}, additionalProperties: false }
		}
	];
}

function text(body: string, isError = false) {
	return { content: [{ type: 'text', text: body }], isError };
}

async function callTool(name: string, args: Record<string, unknown>, timezone: string) {
	switch (name) {
		case 'query': {
			const statement = args.sql;
			if (typeof statement !== 'string' || statement.trim() === '') {
				return text('The `sql` argument is required and must be a non-empty string.', true);
			}
			const limit = typeof args.limit === 'number' ? args.limit : DEFAULT_LIMIT;
			try {
				return text(await runReadOnly(statement, limit));
			} catch (err) {
				// A failed query is a tool result, not a protocol error: the model is
				// meant to read the Postgres message and fix its SQL.
				if (err instanceof SqlError) return text(err.detail, true);
				throw err;
			}
		}
		case 'describe_schema':
			return text(await describeSchema(typeof args.table === 'string' ? args.table : undefined));
		case 'get_business_rules':
			return text(await businessRules(timezone));
		default:
			return null;
	}
}

const ok = (id: string | number | null, result: unknown): JsonRpcResponse => ({
	jsonrpc: '2.0',
	id,
	result
});

const fail = (
	id: string | number | null,
	code: number,
	message: string,
	data?: unknown
): JsonRpcResponse => ({ jsonrpc: '2.0', id, error: { code, message, data } });

/**
 * Handles one JSON-RPC message. Returns null for notifications, which by
 * definition get no reply.
 */
export async function handleMessage(
	message: JsonRpcMessage,
	timezone: string
): Promise<JsonRpcResponse | null> {
	const { method, id = null } = message;
	const params = message.params ?? {};

	if (typeof method !== 'string') {
		return fail(id, -32600, 'Invalid Request: missing method');
	}
	// Notifications carry no id and must never be answered.
	if (method.startsWith('notifications/')) return null;

	try {
		switch (method) {
			case 'initialize': {
				const requested = params.protocolVersion;
				const protocolVersion =
					typeof requested === 'string' &&
					(PROTOCOL_VERSIONS as readonly string[]).includes(requested)
						? requested
						: PREFERRED_PROTOCOL;

				return ok(id, {
					protocolVersion,
					capabilities: { tools: { listChanged: false } },
					serverInfo: SERVER_INFO,
					instructions: await serverInstructions(timezone)
				});
			}

			case 'ping':
				return ok(id, {});

			case 'tools/list':
				return ok(id, { tools: tools(timezone) });

			case 'tools/call': {
				const name = params.name;
				if (typeof name !== 'string') {
					return fail(id, -32602, 'Invalid params: `name` is required');
				}
				const args = (params.arguments ?? {}) as Record<string, unknown>;
				const result = await callTool(name, args, timezone);
				if (!result) return fail(id, -32602, `Unknown tool: ${name}`);
				return ok(id, result);
			}

			// Not advertised in `capabilities`, but clients probe for them anyway
			// and an empty list is friendlier than an error in their logs.
			case 'resources/list':
				return ok(id, { resources: [] });
			case 'resources/templates/list':
				return ok(id, { resourceTemplates: [] });
			case 'prompts/list':
				return ok(id, { prompts: [] });

			default:
				return fail(id, -32601, `Method not found: ${method}`);
		}
	} catch (err) {
		console.error('[mcp] error handling', method, err);
		return fail(id, -32603, 'Internal error', err instanceof Error ? err.message : String(err));
	}
}
