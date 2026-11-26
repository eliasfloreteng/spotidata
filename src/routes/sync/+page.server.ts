import { clearAnalysisMisses, getAnalysisStatus } from '$lib/server/analysis/status.ts';
import { ANALYSE_JOB_KEY, PRIORITY_ANALYSE } from '$lib/server/queue/constants.ts';
import { getWorkerUtils } from '$lib/server/queue/runner.ts';
import { getSyncStatus, listRuns } from '$lib/server/queue/status.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const [status, runs, analysis] = await Promise.all([
		getSyncStatus(),
		listRuns(10),
		getAnalysisStatus()
	]);
	return { status, runs, analysis };
};

export const actions: Actions = {
	/** Ask Deezer again about everything that was not measured, starting now. */
	retryAnalysis: async () => {
		await clearAnalysisMisses();
		const utils = await getWorkerUtils();
		await utils.addJob(
			'analyse:tick',
			{},
			{ jobKey: ANALYSE_JOB_KEY, jobKeyMode: 'replace', priority: PRIORITY_ANALYSE }
		);
		return { retried: true };
	}
};
