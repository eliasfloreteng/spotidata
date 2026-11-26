/**
 * Leaf module — imports nothing.
 *
 * These constants used to live in runner.ts, which created a cycle:
 * helpers → runner → tasks/index → sync-library → helpers. Under that cycle
 * `SPOTIFY_FLAG` was still undefined when `spotifyJob` was evaluated, so every
 * queued job carried `flags: [null]` and Postgres rejected the insert. Keeping
 * shared constants dependency-free makes that class of bug impossible.
 */

/**
 * Marks a job as hitting the Spotify API. While the rate-limit breaker is
 * open, the runner returns this from `forbiddenFlags` and Graphile Worker
 * skips those jobs wholesale instead of running them into a retry storm.
 */
export const SPOTIFY_FLAG = 'spotify-api';

/** On-demand page fetches preempt a running sync (lower = sooner). */
export const PRIORITY_ONDEMAND = -1000;
export const PRIORITY_ONDEMAND_FOLLOWUP = -500;
/** Hydration is the least urgent phase; every chart is correct without it. */
export const PRIORITY_HYDRATE = 100;
