import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { error, json } from '@sveltejs/kit';
import { config } from '$lib/server/config.ts';
import { queueImport, reserveUploadPath } from '$lib/server/import/queue.ts';
import type { RequestHandler } from './$types';

/**
 * Receives an export archive as a raw body and queues it.
 *
 * Deliberately NOT a multipart form: `request.formData()` materialises the
 * whole upload in memory, and a Spotify export is ~500 MB. The browser sends
 * the File object as the body directly, which streams to disk at a constant
 * few megabytes of RSS — and gives the page an upload progress bar for free.
 *
 * Under adapter-node this needs `BODY_SIZE_LIMIT` raised; the default is
 * 512 KB and rejects the request before this handler ever runs.
 */
export const POST: RequestHandler = async ({ request, url }) => {
	const name = (url.searchParams.get('name') ?? 'export.zip').slice(0, 200);
	if (!name.toLowerCase().endsWith('.zip')) {
		error(415, 'Upload the .zip Spotify sent you, or point the importer at an unpacked folder.');
	}

	const declared = Number(request.headers.get('content-length') ?? 0);
	if (declared > config.history.maxUploadBytes) {
		error(413, `That archive is larger than the ${mb(config.history.maxUploadBytes)} MB limit.`);
	}
	if (!request.body) error(400, 'Empty upload');

	const target = await reserveUploadPath(name);
	let written = 0;

	try {
		await pipeline(
			Readable.fromWeb(request.body as Parameters<typeof Readable.fromWeb>[0]),
			async function* (source) {
				for await (const chunk of source) {
					written += (chunk as Buffer).length;
					// Content-Length is a claim, not a promise; enforce the ceiling
					// against what actually arrives.
					if (written > config.history.maxUploadBytes) {
						throw new Error(`Upload exceeded ${mb(config.history.maxUploadBytes)} MB`);
					}
					yield chunk;
				}
			},
			createWriteStream(target)
		);
	} catch (err) {
		await fs.rm(target, { force: true }).catch(() => {});
		error(413, err instanceof Error ? err.message : 'Upload failed');
	}

	const importId = await queueImport({
		label: name,
		path: target,
		kind: 'zip',
		sizeBytes: written,
		temporary: true
	});

	return json({ importId, bytes: written });
};

const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);
