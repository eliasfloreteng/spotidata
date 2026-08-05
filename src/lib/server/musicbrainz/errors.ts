/**
 * The breaker for a third-party service is open — either because it asked us
 * to stop (429/503 + Retry-After) or because the token bucket is empty and the
 * wait is longer than a worker slot is worth.
 *
 * Carries the instant it lifts, so the enrichment chain can hand the job back
 * to the queue with `runAt` set instead of sleeping on it.
 */
export class ServiceBlocked extends Error {
	constructor(
		readonly service: string,
		readonly until: Date
	) {
		super(`${service} unavailable until ${until.toISOString()}`);
		this.name = 'ServiceBlocked';
	}
}

export class MusicbrainzError extends Error {
	constructor(
		readonly status: number,
		readonly path: string,
		readonly body: string
	) {
		super(`MusicBrainz ${status} on ${path}: ${body.slice(0, 200)}`);
		this.name = 'MusicbrainzError';
	}
}
