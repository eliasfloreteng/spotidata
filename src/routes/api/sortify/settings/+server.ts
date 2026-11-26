import { handle, json, body } from '$lib/server/sortify/http.ts';
import { models } from '$lib/server/sortify/ai.ts';
import { setSetting } from '$lib/server/settings.ts';
import { apiError } from '$lib/server/sortify/http.ts';
import type { RequestHandler } from './$types';

const shape = async () => {
	const m = await models();
	return { card_model: m.cardModel, sort_model: m.sortModel, ideas_model: m.ideasModel };
};

/** GET — the OpenRouter models Sortify uses. */
export const GET: RequestHandler = ({ url }) => handle(url, async () => json(await shape()));

/** PUT {card_model?, sort_model?, ideas_model?} — an OpenRouter model id each, e.g. `openai/gpt-6-luna`. */
export const PUT: RequestHandler = ({ url, request }) =>
	handle(url, async () => {
		const input = await body<Record<string, unknown>>(request);
		const keys = { card_model: 'sortify.cardModel', sort_model: 'sortify.sortModel', ideas_model: 'sortify.ideasModel' } as const;
		for (const [field, key] of Object.entries(keys)) {
			const value = input[field];
			if (value === undefined) continue;
			if (typeof value !== 'string' || !/^[\w.-]+\/[\w.:-]+$/.test(value.trim())) {
				return apiError(400, 'invalid', `${field} must be an OpenRouter model id like openai/gpt-6-luna.`);
			}
			await setSetting(key, value.trim());
		}
		return json(await shape());
	});
