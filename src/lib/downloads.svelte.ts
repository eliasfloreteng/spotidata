import { getContext, setContext, untrack } from 'svelte';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { isActive, NONE, type DownloadStatus, type TrackRef } from './downloads.ts';

/**
 * The download state of a page's tracks, for its buttons to draw and act on.
 *
 * The page's load hands in where each track stood when it rendered; acting on
 * one (download, retry, stop) updates it from the answer, and while anything
 * is under way the page asks again every few seconds, for the tracks it shows
 * and nothing else. A new load (navigating, or the page reloading its data)
 * starts over from what it says.
 */

interface Source {
	statuses: Record<string, DownloadStatus>;
	refs: TrackRef[];
}

const KEY = Symbol('downloads');
const POLL_MS = 3000;

async function failure(res: Response): Promise<string> {
	const text = (await res.text().catch(() => '')).trim();
	return text || `The request failed (${res.status}).`;
}

export class DownloadTracker {
	#source: () => Source = () => ({ statuses: {}, refs: [] });
	/** Newer than the load: what actions and polling have learned since. */
	#live = $state<Record<string, DownloadStatus>>({});

	/** Tracks with a request in flight. */
	readonly busy = new SvelteSet<string>();
	/** What went wrong with a track's last action, by Spotify id. */
	readonly errors = new SvelteMap<string, string>();
	/** What went wrong with the last action on many tracks at once. */
	bulkError = $state<string | null>(null);
	bulkBusy = $state(false);

	constructor(source: () => Source) {
		this.#source = source;
	}

	readonly statuses = $derived({ ...this.#source().statuses, ...this.#live });

	/** Forgets what was learned on top of the load, for a new one. */
	reset(): void {
		this.#live = {};
		this.errors.clear();
		this.bulkError = null;
	}

	/** The load's statuses, to tell a new load from the last. */
	get loaded(): Record<string, DownloadStatus> {
		return this.#source().statuses;
	}

	status(id: string): DownloadStatus {
		return this.statuses[id] ?? NONE;
	}

	/** Something is under way, so the page should look again. */
	readonly active = $derived(Object.values(this.statuses).some(isActive));

	#merge(statuses: Record<string, DownloadStatus>) {
		this.#live = { ...this.#live, ...statuses };
	}

	/** Asks where the page's tracks stand now. */
	async refresh(): Promise<void> {
		const refs = this.#source().refs;
		if (refs.length === 0) return;
		const res = await fetch('/api/downloads/status', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ tracks: refs })
		}).catch(() => null);
		if (res?.ok) this.#merge(await res.json());
	}

	/** Has the engine get these tracks. Answers what went wrong, or null. */
	async download(ids: string[]): Promise<string | null> {
		if (ids.length === 0) return null;
		for (const id of ids) {
			this.busy.add(id);
			this.errors.delete(id);
		}
		try {
			const res = await fetch('/api/downloads', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ tracks: ids })
			}).catch(() => null);
			if (!res) return this.#fail(ids, 'Spotidata is not reachable.');
			if (!res.ok) return this.#fail(ids, await failure(res));
			const body = (await res.json()) as { statuses: Record<string, DownloadStatus>; unknown: string[] };
			this.#merge(body.statuses);
			for (const id of body.unknown) this.errors.set(id, 'Spotify no longer describes this track.');
			return null;
		} finally {
			for (const id of ids) this.busy.delete(id);
		}
	}

	/** Every track of `ids` the folder lacks and nothing is getting. */
	async downloadAll(ids: string[]): Promise<void> {
		this.bulkBusy = true;
		this.bulkError = null;
		try {
			this.bulkError = await this.download(ids);
		} finally {
			this.bulkBusy = false;
		}
	}

	retry(id: string, download: number): Promise<string | null> {
		return this.#act(id, `/api/downloads/${download}/retry`, 'POST');
	}

	/** Stops a download under way. */
	stop(id: string, download: number): Promise<string | null> {
		return this.#act(id, `/api/downloads/${download}`, 'DELETE');
	}

	async #act(id: string, url: string, method: string): Promise<string | null> {
		this.busy.add(id);
		this.errors.delete(id);
		try {
			const res = await fetch(url, { method }).catch(() => null);
			if (!res) return this.#fail([id], 'Spotidata is not reachable.');
			if (!res.ok) return this.#fail([id], await failure(res));
			await this.refresh();
			return null;
		} finally {
			this.busy.delete(id);
		}
	}

	#fail(ids: string[], message: string): string {
		for (const id of ids) this.errors.set(id, message);
		return message;
	}
}

/**
 * Sets up the tracker for a page's tracks, for every download button under
 * it, and keeps it fresh while something is under way.
 */
export function provideDownloads(source: () => Source): DownloadTracker {
	const tracker = new DownloadTracker(source);
	$effect.pre(() => {
		// A new load supersedes everything learned on top of the last one.
		void tracker.loaded;
		untrack(() => tracker.reset());
	});
	$effect(() => {
		// Read through `statuses` so every answer schedules the next look.
		void tracker.statuses;
		if (!tracker.active) return;
		const timer = setTimeout(() => void tracker.refresh(), POLL_MS);
		return () => clearTimeout(timer);
	});
	setContext(KEY, tracker);
	return tracker;
}

export function useDownloads(): DownloadTracker {
	const tracker = getContext<DownloadTracker | undefined>(KEY);
	if (!tracker) throw new Error('A download button needs provideDownloads() on its page.');
	return tracker;
}
