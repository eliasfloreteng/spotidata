import { readAuthState, getAccessToken } from '../src/lib/server/spotify/auth.ts';
import { closePools } from '../src/lib/server/db/index.ts';
import { probeApi, clientCredentialsToken } from '../src/lib/server/spotify/probe.ts';

if (import.meta.main) {
	const auth = await readAuthState();
	const useUserToken = auth && !auth.needsReauth;
	const token = useUserToken ? await getAccessToken() : await clientCredentialsToken();

	console.log(`\nSpotify API probe — ${useUserToken ? 'USER token' : 'client-credentials token'}`);
	if (!useUserToken) {
		console.log('(no user grant yet; popularity and available_markets will read as empty)');
	}
	console.log('');

	const results = await probeApi(token);
	for (const r of results) {
		const mark = r.ok ? '✓' : '✗';
		const detail = r.ok ? `${r.status}` : `${r.status}, expected ${r.expect}`;
		console.log(`  ${mark} ${r.name.padEnd(32)} ${detail.padEnd(18)} ${r.note ?? ''}`);
	}

	const failed = results.filter((r) => !r.ok);
	console.log(
		failed.length === 0
			? '\nAll probes match the recorded contract.\n'
			: `\n${failed.length} probe(s) DIVERGED from the recorded contract — the API changed.\n`
	);

	await closePools();
	process.exit(failed.length === 0 ? 0 : 1);
}
