import { EngineRefused, EngineUnavailable } from './client.ts';

/**
 * Runs a route's call to the engine, answering what went wrong in words the
 * page shows as they are: 503 while the engine is down, the engine's own
 * status and reason when it said no.
 */
export async function engineRoute(fn: () => Promise<Response>): Promise<Response> {
	try {
		return await fn();
	} catch (err) {
		const headers = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };
		if (err instanceof EngineUnavailable) return new Response(err.message, { status: 503, headers });
		if (err instanceof EngineRefused) return new Response(err.message, { status: err.status, headers });
		throw err;
	}
}

/** The JSON body, or null when it is not JSON. */
export async function jsonBody(request: Request): Promise<unknown> {
	return request.json().catch(() => null);
}
