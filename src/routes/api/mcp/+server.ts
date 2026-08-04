import { config } from '$lib/server/config.ts';
import { handleMessage, type JsonRpcMessage } from '$lib/server/mcp/server.ts';
import type { RequestHandler } from './$types';

/**
 * The MCP endpoint: Streamable HTTP, stateless, POST only.
 *
 * DELIBERATELY UNAUTHENTICATED. In deployment an OAuth proxy sits in front of
 * the whole app and this route inherits it; locally it is as reachable as every
 * other route on 127.0.0.1. What it does enforce is the transport-level guard
 * the spec asks for — an `Origin` a browser attached must be one we allow, so a
 * random page cannot use the developer's own browser to read the database.
 *
 * There is no GET: SSE only exists for server-initiated messages, and a
 * request/response SQL tool has none. No session id either — every POST is
 * self-contained, so a restart costs a client nothing.
 */

const JSON_RPC_PARSE_ERROR = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };

function corsHeaders(origin: string | null): Record<string, string> {
	if (!origin || !config.mcp.allowedOrigins.includes(origin)) return {};
	return {
		'access-control-allow-origin': origin,
		'access-control-allow-methods': 'POST, OPTIONS',
		'access-control-allow-headers': 'content-type, mcp-protocol-version, mcp-session-id',
		'access-control-max-age': '86400',
		vary: 'origin'
	};
}

/** Present and unlisted means a browser sent it from a page we do not trust. */
function originRejected(origin: string | null): boolean {
	return origin !== null && !config.mcp.allowedOrigins.includes(origin);
}

export const POST: RequestHandler = async ({ request, locals }) => {
	const origin = request.headers.get('origin');
	if (originRejected(origin)) {
		return new Response('Origin not allowed', { status: 403 });
	}

	let payload: unknown;
	try {
		payload = await request.json();
	} catch {
		return Response.json(JSON_RPC_PARSE_ERROR, { status: 400, headers: corsHeaders(origin) });
	}

	const timezone = locals.settings['ui.timezone'];
	const headers = { ...corsHeaders(origin), 'cache-control': 'no-store' };

	// Batching was removed in protocol 2025-06-18 but older clients still send
	// arrays, and answering one is barely more work than rejecting it.
	if (Array.isArray(payload)) {
		const replies = await Promise.all(
			payload.map((m) => handleMessage(m as JsonRpcMessage, timezone))
		);
		const answered = replies.filter((r) => r !== null);
		if (answered.length === 0) return new Response(null, { status: 202, headers });
		return Response.json(answered, { headers });
	}

	if (typeof payload !== 'object' || payload === null) {
		return Response.json(JSON_RPC_PARSE_ERROR, { status: 400, headers });
	}

	const reply = await handleMessage(payload as JsonRpcMessage, timezone);
	// A notification gets no body; the spec asks for 202 rather than an empty 200.
	if (!reply) return new Response(null, { status: 202, headers });
	return Response.json(reply, { headers });
};

export const OPTIONS: RequestHandler = async ({ request }) => {
	const origin = request.headers.get('origin');
	if (originRejected(origin)) return new Response(null, { status: 403 });
	return new Response(null, { status: 204, headers: corsHeaders(origin) });
};

/** The spec's answer for a server that offers no SSE stream and no sessions. */
const notAllowed = () =>
	new Response('Method not allowed. This MCP endpoint is POST-only.', {
		status: 405,
		headers: { allow: 'POST, OPTIONS' }
	});

export const GET: RequestHandler = async () => notAllowed();
export const DELETE: RequestHandler = async () => notAllowed();
