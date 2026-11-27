import { engineDownloads, engineError, type EngineDownloads } from './client.ts';
import { recordingsOf } from './downloads.ts';

/** What the engine said, or why it could not. */
export type Read<T> = { ok: true; value: T } | { ok: false; error: string };

export async function read<T>(fn: () => Promise<T>): Promise<Read<T>> {
	try {
		return { ok: true, value: await fn() };
	} catch (err) {
		return { ok: false, error: engineError(err) };
	}
}

export interface Queue {
	queue: Read<EngineDownloads>;
	/** The recording each download is of, by download id, for links. */
	recordings: Record<number, string>;
}

/** The queue, the sources and the settings, with where each download links to. */
export async function readQueue(): Promise<Queue> {
	const queue = await read(engineDownloads);
	return { queue, recordings: queue.ok ? await recordingsOf(queue.value.downloads) : {} };
}
