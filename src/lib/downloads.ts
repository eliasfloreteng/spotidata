/**
 * Where a track stands with Deckhand's engine, as every page that lists tracks
 * shows it: in the music folder, being got, failed, or neither. Shared by the
 * server, which works it out (`$lib/server/engine/downloads.ts`), and the
 * download buttons, which draw it and keep it fresh.
 */

/** A download still under way, as the engine names its steps. */
export type DownloadPhase = 'queued' | 'searching' | 'downloading' | 'finishing' | 'waiting';

export type DownloadStatus =
	/** The music folder holds the recording. */
	| { state: 'here'; file: string }
	| {
			state: 'getting';
			id: number;
			phase: DownloadPhase;
			/** The source being tried. */
			source: string | null;
			/** For `waiting`: what it waits for. */
			detail: string | null;
			/** Bytes so far and in all, while downloading. */
			received?: number;
			total?: number | null;
	  }
	/** The last try failed; `error` says why. */
	| { state: 'failed'; id: number; error: string | null }
	| { state: 'none' };

/** A track to look up: its Spotify id, and its ISRC when the caller knows it. */
export interface TrackRef {
	id: string;
	isrc?: string | null;
}

export const NONE: DownloadStatus = { state: 'none' };

const PHASES: Record<DownloadPhase, string> = {
	queued: 'Queued',
	searching: 'Searching',
	downloading: 'Downloading',
	finishing: 'Finishing',
	waiting: 'Waiting for you'
};

export function phaseLabel(phase: DownloadPhase): string {
	return PHASES[phase];
}

/** "42%", or null before the engine knows the size. */
export function progress(s: DownloadStatus): string | null {
	if (s.state !== 'getting' || s.phase !== 'downloading' || !s.total || !s.received) return null;
	return `${Math.min(99, Math.floor((s.received / s.total) * 100))}%`;
}

/** Something the engine is still doing, so the page should look again soon. */
export function isActive(s: DownloadStatus | undefined): boolean {
	return s?.state === 'getting' && s.phase !== 'waiting';
}

/** What the folder could still take: neither there nor on the way. */
export function isMissing(s: DownloadStatus | undefined): boolean {
	return !s || s.state === 'none' || s.state === 'failed';
}
