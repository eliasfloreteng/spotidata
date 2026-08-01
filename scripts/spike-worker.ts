import { config } from '../src/lib/server/config.ts';
import { workerPool, closePools } from '../src/lib/server/db/index.ts';
import { run, makeWorkerUtils } from 'graphile-worker';

/**
 * P4 decision gate: is Graphile Worker usable under the Bun runtime?
 *
 * Graphile Worker is pure JS, but its low-latency wakeup path rides
 * node-postgres LISTEN/NOTIFY over Bun's net/tls shim, which nobody appears to
 * run in production. Two things decide it:
 *
 *   1. THROUGHPUT — can it drain a burst of jobs at all?
 *   2. WAKEUP LATENCY — with an *idle* worker, how long between addJob and
 *      execution? If LISTEN/NOTIFY is broken this silently degrades to
 *      `pollInterval` (here 10s), which is the signal we are looking for.
 *
 * Run under both runtimes and compare:
 *   bun  scripts/spike-worker.ts
 *   node --experimental-strip-types scripts/spike-worker.ts
 */

const RUNTIME =
	typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
		? `bun ${process.versions.bun}`
		: `node ${process.version}`;

const BURST = Number(process.env.SPIKE_BURST ?? 1000);
const LATENCY_SAMPLES = Number(process.env.SPIKE_SAMPLES ?? 10);

console.log(`\n=== Graphile Worker spike — runtime: ${RUNTIME} ===\n`);

const utils = await makeWorkerUtils({ pgPool: workerPool });

let burstDone = 0;
let burstResolve: (() => void) | undefined;
const latencies: number[] = [];
let latencyResolve: ((ms: number) => void) | undefined;

const runner = await run({
	pgPool: workerPool,
	concurrency: config.worker.concurrency,
	// Deliberately long: if LISTEN/NOTIFY works we should never wait this long.
	// Any latency near 10_000ms means we fell back to polling.
	pollInterval: 10_000,
	noHandleSignals: true,
	taskList: {
		noop: async () => {
			burstDone++;
			if (burstDone >= BURST) burstResolve?.();
		},
		ping: async (payload) => {
			const sentAt = (payload as { sentAt: number }).sentAt;
			latencyResolve?.(Date.now() - sentAt);
		}
	}
});

// ---------------------------------------------------------------- throughput

console.log(`[1/2] enqueueing ${BURST} no-op jobs…`);
const enqueueStart = Date.now();
for (let i = 0; i < BURST; i += 500) {
	const chunk = Array.from({ length: Math.min(500, BURST - i) }, (_, j) => ({
		identifier: 'noop',
		payload: { n: i + j }
	}));
	await utils.addJobs(chunk);
}
const enqueueMs = Date.now() - enqueueStart;

const drainStart = Date.now();
await new Promise<void>((resolve) => {
	burstResolve = resolve;
	if (burstDone >= BURST) resolve();
});
const drainMs = Date.now() - drainStart;

console.log(
	`      enqueued in ${enqueueMs}ms · drained ${BURST} jobs in ${drainMs}ms ` +
		`(${Math.round((BURST / drainMs) * 1000)} jobs/s)`
);

// ------------------------------------------------------------------ latency

console.log(`\n[2/2] measuring NOTIFY→execute latency on an idle worker…`);
for (let i = 0; i < LATENCY_SAMPLES; i++) {
	// Let the pool settle so the worker is genuinely idle and must be woken.
	await new Promise((r) => setTimeout(r, 300));
	const ms = await new Promise<number>((resolve) => {
		latencyResolve = resolve;
		void utils.addJob('ping', { sentAt: Date.now() });
	});
	latencies.push(ms);
	process.stdout.write(`      #${i + 1}: ${ms}ms\n`);
}

latencies.sort((a, b) => a - b);
const median = latencies[Math.floor(latencies.length / 2)] ?? 0;
const max = latencies.at(-1) ?? 0;

console.log(`\n--- result (${RUNTIME}) ---`);
console.log(`throughput : ${Math.round((BURST / drainMs) * 1000)} jobs/s`);
console.log(`latency    : median ${median}ms · max ${max}ms`);

const pass = median < 100 && max < 1000;
console.log(
	pass
		? `VERDICT    : PASS — LISTEN/NOTIFY wakeup works, embedded mode is viable`
		: `VERDICT    : FAIL — latency suggests polling fallback; use WORKER_MODE=external`
);

await runner.stop();
await utils.release();
await closePools();
process.exit(pass ? 0 : 1);
