import type { Handle, ServerInit } from '@sveltejs/kit';
import { startWorker, stopWorker } from '$lib/server/queue/runner.ts';
import { loadSettings } from '$lib/server/settings.ts';
import { flushCallStats } from '$lib/server/spotify/ratelimit.ts';

export const init: ServerInit = async () => {
	// The queue lives in-process: verified under Bun at ~4,500 jobs/s with
	// ~12ms wakeup latency. WORKER_MODE=external moves it to `bun run worker`.
	await startWorker();
};

let cached: { value: Awaited<ReturnType<typeof loadSettings>>; at: number } | null = null;

export const handle: Handle = async ({ event, resolve }) => {
	// Settings are read on essentially every request (link scheme, timezone),
	// and change only from the settings form. A short cache keeps that off the
	// hot path without making the UI feel stale.
	if (!cached || Date.now() - cached.at > 5000) {
		cached = { value: await loadSettings(), at: Date.now() };
	}
	event.locals.settings = cached.value;

	return resolve(event);
};

/** Lets the settings form drop the cache immediately after a write. */
export function invalidateSettingsCache(): void {
	cached = null;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.once(signal, () => {
		void (async () => {
			await flushCallStats();
			await stopWorker();
			process.exit(0);
		})();
	});
}
