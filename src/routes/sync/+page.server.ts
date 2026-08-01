import { getSyncStatus, listRuns } from '$lib/server/queue/status.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => ({
	status: await getSyncStatus(),
	runs: await listRuns(10)
});
