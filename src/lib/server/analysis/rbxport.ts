import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.ts';

/**
 * The `analyser/` binary: rbxport's tempo and key, over a batch of files.
 *
 * A child process rather than a library because rbxport is Rust. One process
 * per batch, not per file, and it reports each file on its own line, so a
 * file it cannot read costs that file alone.
 */

const run = promisify(execFile);

export interface Measured {
	file: string;
	bpm: number;
	bpmConfidence: number;
	seconds: number;
	key: { name: string; camelot: string; tonic: number; minor: boolean } | null;
	rms: number;
	peak: number;
}

export type Result = Measured | { file: string; error: string };

let version: string | null = null;

/** e.g. `rbxport@ebc7ef22+0.1.0`, read once from the binary. */
export async function analyserVersion(): Promise<string> {
	version ??= (await run(config.analysis.bin, ['--version'])).stdout.trim();
	return version;
}

export async function analyse(files: string[]): Promise<Map<string, Result>> {
	if (files.length === 0) return new Map();
	// A preview takes a fraction of a second; a minute for a batch means a hang.
	const { stdout } = await run(config.analysis.bin, files, {
		timeout: 60_000 + files.length * 10_000,
		maxBuffer: 1 << 20
	});
	const out = new Map<string, Result>();
	for (const line of stdout.split('\n')) {
		if (!line.trim()) continue;
		const r = JSON.parse(line) as Result;
		out.set(r.file, r);
	}
	return out;
}
