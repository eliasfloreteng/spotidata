import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { sortifyLibrary } from '$lib/server/export/sortify.ts';
import type { RequestHandler } from './$types';

/**
 * The library feature store for Sortify, the iOS playlist sorter
 * (see `src/lib/server/export/sortify.ts` for the fields).
 *
 * Read-only and unauthenticated like every other route here: the deployment
 * keeps the whole host tailnet-only. The ETag lets the app revalidate its
 * cached copy for the price of the query alone, and the body is gzipped here
 * because adapter-node serves dynamic responses uncompressed — 3 MB of JSON is
 * ~10× smaller on the wire.
 */
export const GET: RequestHandler = async ({ request }) => {
	const body = await sortifyLibrary();
	const etag = `"${createHash('sha1').update(body).digest('base64url')}"`;
	const headers: Record<string, string> = {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-cache',
		etag,
		vary: 'accept-encoding'
	};
	if (request.headers.get('if-none-match') === etag) {
		return new Response(null, { status: 304, headers });
	}
	if (/\bgzip\b/.test(request.headers.get('accept-encoding') ?? '')) {
		return new Response(gzipSync(body), { headers: { ...headers, 'content-encoding': 'gzip' } });
	}
	return new Response(body, { headers });
};
