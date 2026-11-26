import { getSyncStatus, listRuns } from '$lib/server/queue/status.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const [status, runs] = await Promise.all([getSyncStatus(), listRuns(10)]);
	return { status, runs };
};
