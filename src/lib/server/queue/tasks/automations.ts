import type { Task } from 'graphile-worker';
import { autoRunAutomationIds, runAutomation } from '../../playlists/automations.ts';
import { PlaylistScopeError } from '../../playlists/sync.ts';
import { SpotifyAuthExpired, SpotifyRateLimited } from '../../spotify/errors.ts';
import { SPOTIFY_FLAG } from '../constants.ts';

/**
 * Running playlist automations in the background.
 *
 * Same contract as the generated-playlist jobs next door: one job per
 * automation so a failing one leaves the others alone, and `SPOTIFY_FLAG` so an
 * open rate-limit breaker skips them wholesale instead of burning retries. An
 * automation that is an hour late has cost nobody anything; a 429 that stalls
 * the sync has.
 */

/** Fans out to one job per auto-running automation. */
export const runAllAutomations: Task = async (_payload, helpers) => {
	const ids = await autoRunAutomationIds();
	for (const id of ids) {
		await helpers.addJob(
			'automation:run',
			{ automationId: id },
			{ jobKey: `automation-run:${id}`, jobKeyMode: 'preserve_run_at', flags: [SPOTIFY_FLAG] }
		);
	}
	if (ids.length) helpers.logger.info(`[automations] queued ${ids.length} automation(s)`);
};

export const runAutomationTask: Task = async (payload, helpers) => {
	const { automationId } = payload as { automationId: string };

	try {
		const result = await runAutomation(automationId);
		helpers.logger.info(`[automations] ${automationId}: ${result.status} — ${result.message}`);
	} catch (err) {
		// A missing scope or an expired grant is not transient: every retry costs
		// a request and fails identically until somebody re-authorizes. The error
		// is already recorded on the automation, which is where the page reads it.
		if (err instanceof PlaylistScopeError || err instanceof SpotifyAuthExpired) {
			helpers.logger.warn(`[automations] ${automationId}: authorization cannot write playlists`);
			return;
		}
		// The breaker is open. Come back when it closes rather than retrying into
		// it — appending is idempotent against the ledger, so a re-run adds only
		// what the interrupted one never got to.
		if (err instanceof SpotifyRateLimited) {
			await helpers.addJob(
				'automation:run',
				{ automationId },
				{
					jobKey: `automation-run:${automationId}`,
					jobKeyMode: 'replace',
					runAt: err.until,
					flags: [SPOTIFY_FLAG]
				}
			);
			return;
		}
		throw err;
	}
};
