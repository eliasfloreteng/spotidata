import { config } from '../config.ts';
import { db } from '../db/index.ts';
import { sortifyAiRequests } from '../db/schema/index.ts';

/**
 * OpenRouter's chat completions, for Sortify's playlist suggestions.
 *
 * One system prompt and one user prompt in, one JSON object out. The user
 * prompt is sent as a cacheable block, so a long and stable prefix — the
 * playlist catalog — is billed at the cache rate on the next call. Every
 * request is logged with what it cost (OpenRouter reports it per request),
 * which is where the app's "spent so far" comes from.
 */

export class OpenRouterError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'OpenRouterError';
	}
}

export class OpenRouterUnavailable extends OpenRouterError {
	constructor() {
		super('No OpenRouter key is configured on Spotidata (OPENROUTER_API_KEY).');
		this.name = 'OpenRouterUnavailable';
	}
}

export type Reasoning = { enabled: false } | { effort: 'minimal' | 'low' | 'medium' | 'high' };

export interface JsonRequest {
	kind: 'card' | 'songs' | 'playlist' | 'ideas';
	model: string;
	system: string;
	user: string;
	/** Songs in the prompt, for the log. */
	items: number;
	reasoning?: Reasoning;
	timeoutMs?: number;
}

export const isAvailable = () => config.openRouter.apiKey !== '';

interface Response {
	choices?: Array<{ message?: { content?: string | null } }>;
	usage?: { cost?: number };
	error?: { message?: string };
}

export async function openRouterJson<T>(req: JsonRequest): Promise<T> {
	try {
		return await send<T>(req, req.reasoning ?? { enabled: false });
	} catch (err) {
		// Some models cannot run without reasoning; retry with the smallest budget they accept.
		if (err instanceof OpenRouterError && /reasoning is mandatory/i.test(err.message)) {
			return send<T>(req, { effort: 'low' });
		}
		throw err;
	}
}

async function send<T>(req: JsonRequest, reasoning: Reasoning): Promise<T> {
	if (!isAvailable()) throw new OpenRouterUnavailable();
	const started = Date.now();
	let cost: number | null = null;
	let failure: string | null = null;
	try {
		const res = await fetch(config.openRouter.url, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${config.openRouter.apiKey}`,
				'Content-Type': 'application/json',
				'X-Title': 'Sortify'
			},
			body: JSON.stringify({
				model: req.model,
				messages: [
					{ role: 'system', content: req.system },
					{
						role: 'user',
						content: [{ type: 'text', text: req.user, cache_control: { type: 'ephemeral' } }]
					}
				],
				response_format: { type: 'json_object' },
				reasoning,
				usage: { include: true }
			}),
			signal: AbortSignal.timeout(req.timeoutMs ?? 90_000)
		});
		const text = await res.text();
		let body: Response;
		try {
			body = JSON.parse(text) as Response;
		} catch {
			throw new OpenRouterError(`OpenRouter answered ${res.status}: ${text.slice(0, 200)}`);
		}
		cost = body.usage?.cost ?? null;
		if (body.error) throw new OpenRouterError(body.error.message ?? `OpenRouter error ${res.status}`);
		const content = body.choices?.[0]?.message?.content;
		if (!content) throw new OpenRouterError('The model returned nothing.');
		try {
			return JSON.parse(outermostObject(content)) as T;
		} catch {
			throw new OpenRouterError('The model did not answer with JSON.');
		}
	} catch (err) {
		failure =
			err instanceof Error
				? err.name === 'TimeoutError'
					? 'The model took too long to answer.'
					: err.message
				: String(err);
		if (err instanceof OpenRouterError) throw err;
		throw new OpenRouterError(failure);
	} finally {
		await db
			.insert(sortifyAiRequests)
			.values({
				kind: req.kind,
				model: req.model,
				items: req.items,
				costUsd: cost,
				durationMs: Date.now() - started,
				error: failure
			})
			.catch(() => {});
	}
}

/** Models occasionally wrap the JSON in code fences or a sentence; keep the outermost object. */
function outermostObject(text: string): string {
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

/** A numeric reference the model writes either as 12 or as "P12"/"S12". */
export function refIndex(value: unknown): number | null {
	if (typeof value === 'number' && Number.isInteger(value)) return value;
	if (typeof value === 'string') {
		const digits = value.replace(/\D+/g, '');
		return digits ? Number.parseInt(digits, 10) : null;
	}
	return null;
}
