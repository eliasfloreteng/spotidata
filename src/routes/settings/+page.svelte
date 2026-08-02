<script lang="ts">
	import { enhance } from '$app/forms';
	import { spotifyLink } from '$lib/utils/spotify-uri.ts';
	import { num, shortDate } from '$lib/utils/format.ts';

	let { data, form } = $props();

	let scheme = $state(data.settings['links.scheme']);

	// Live preview so the effect of the toggle is obvious before saving.
	const preview = $derived(spotifyLink('track', '11dFghVXANMlKmJXsNCbNl', scheme));

	const expiryTone = $derived(
		data.daysLeft === null
			? 'muted'
			: data.daysLeft < 7
				? 'bad'
				: data.daysLeft < 30
					? 'warn'
					: 'good'
	);
</script>

<svelte:head><title>Settings · Spotidata</title></svelte:head>

<h1>Settings</h1>

{#if form?.saved}<p class="flash">Saved.</p>{/if}
{#if form?.error}<p class="flash bad">{form.error}</p>{/if}

<section class="card">
	<h2>Spotify account</h2>
	{#if data.needsReauth}
		<p class="tone-bad">
			Re-authorization required — the refresh token expired or was revoked. All ingested
			data is preserved; only the token is replaced.
		</p>
		<a class="btn btn-primary" href="/auth/login">Re-authorize</a>
	{:else if data.authorized}
		<dl>
			<dt>Account</dt>
			<dd>{data.me?.displayName ?? '—'} <span class="faint">({data.me?.id})</span></dd>
			<dt>Market / plan</dt>
			<dd>{data.me?.country ?? '—'} · {data.me?.product ?? '—'}</dd>
			<dt>Authorized</dt>
			<dd>{shortDate(data.authorizedAt)}</dd>
			<dt>Refresh token</dt>
			<dd class="tone-{expiryTone}">
				{#if data.daysLeft !== null}
					expires in {data.daysLeft} days
					<span class="faint">({shortDate(data.refreshExpiresAt)})</span>
				{:else}—{/if}
			</dd>
		</dl>
		<p class="faint small">
			Spotify refresh tokens last 180 days from the original authorization and refreshing
			does not extend that. Renewing replaces only the token — no resync.
		</p>
		<div class="row">
			<a class="btn" href="/auth/login">Renew authorization</a>
			<form method="POST" action="/auth/logout"><button class="btn" type="submit">Sign out</button></form>
		</div>
	{:else}
		<p class="muted">Not connected.</p>
		<a class="btn btn-primary" href="/auth/login">Connect Spotify</a>
	{/if}
</section>

<form method="POST" action="?/save" use:enhance>
	<section class="card">
		<h2>Links</h2>
		<p class="faint small">How every "Open in Spotify" link behaves across the app.</p>
		<div class="options">
			<label class="opt" class:on={scheme === 'uri'}>
				<input type="radio" name="linkScheme" value="uri" bind:group={scheme} />
				<span>
					<strong>Desktop app</strong>
					<em>spotify: URI — opens the installed client</em>
				</span>
			</label>
			<label class="opt" class:on={scheme === 'web'}>
				<input type="radio" name="linkScheme" value="web" bind:group={scheme} />
				<span>
					<strong>Web player</strong>
					<em>open.spotify.com — opens a browser tab</em>
				</span>
			</label>
		</div>
		<p class="preview"><span class="faint small">Preview:</span> <code>{preview}</code></p>
	</section>

	<section class="card">
		<h2>Display</h2>
		<div class="fields">
			<label>
				<span>Timezone</span>
				<input name="timezone" value={data.settings['ui.timezone']} />
				<em class="faint small">Every date bucket in every chart is computed in this zone.</em>
			</label>
			<label>
				<span>Week starts</span>
				<select name="weekStart" value={data.settings['ui.weekStart']}>
					<option value="monday">Monday</option>
					<option value="sunday">Sunday</option>
				</select>
			</label>
		</div>
	</section>

	<section class="card">
		<h2>Sync</h2>
		<div class="fields">
			<label>
				<span>Target request rate</span>
				<input
					name="targetRpm"
					type="number"
					min="10"
					max="600"
					value={data.settings['ratelimit.targetRpm']}
				/>
				<em class="faint small">
					Requests per minute. Spotify does not publish a limit; ~150 is the observed
					ceiling. A 429 halves this automatically and it ramps back up.
				</em>
			</label>
			<label class="check">
				<input
					type="checkbox"
					name="storeRaw"
					checked={data.settings['sync.storeRawPayloads']}
				/>
				<span>
					Keep raw API payloads
					<em class="faint small">
						~300 MB. Lets a schema mistake be fixed with SQL instead of a full refetch.
					</em>
				</span>
			</label>
		</div>
		{#if data.limiter}
			<p class="faint small">
				Currently {Math.round(data.limiter.refillPerSec * 60)} rpm ·
				{num(data.limiter.requestsTotal)} requests made ·
				{data.limiter.consecutive429} recent 429s
			</p>
		{/if}
	</section>

	<button class="btn btn-primary" type="submit">Save settings</button>
</form>

<style>
	section {
		padding: 20px 22px;
		margin: var(--gap) 0;
	}
	h2 {
		margin-bottom: 10px;
	}
	dl {
		display: grid;
		grid-template-columns: 150px 1fr;
		gap: 8px 16px;
		margin: 12px 0 14px;
	}
	dt {
		color: var(--text-muted);
		font-size: 0.86rem;
	}
	dd {
		margin: 0;
		/* Account ids and token dates are unbroken strings wider than the value
		   column; without this they run off the card rather than wrapping. */
		min-width: 0;
		overflow-wrap: anywhere;
	}
	/* Phone: the 150px label column leaves the value nothing to live in, so
	   label and value stack into pairs instead of columns. */
	@media (max-width: 640px) {
		section {
			padding: var(--card-py) var(--card-px);
		}
		dl {
			grid-template-columns: 1fr;
			gap: 10px;
		}
		dt {
			font-size: 0.78rem;
			text-transform: uppercase;
			letter-spacing: 0.06em;
			color: var(--text-faint);
		}
		dd + dt {
			margin-top: 4px;
		}
	}
	.row {
		display: flex;
		gap: 8px;
		align-items: center;
		margin-top: 12px;
		flex-wrap: wrap;
	}
	.row form {
		display: inline;
	}
	.options {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 10px;
		margin: 14px 0 12px;
	}
	@media (max-width: 700px) {
		.options {
			grid-template-columns: 1fr;
		}
	}
	.opt {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		padding: 12px 14px;
		border: 1px solid var(--hairline);
		border-radius: var(--radius-sm);
		cursor: pointer;
		background: var(--bg-elevated);
	}
	.opt.on {
		border-color: rgba(124, 58, 237, 0.6);
		background: var(--accent-soft);
	}
	.opt strong {
		display: block;
		font-weight: 550;
		font-size: 0.9rem;
	}
	.opt em {
		display: block;
		font-style: normal;
		color: var(--text-muted);
		font-size: 0.78rem;
		margin-top: 2px;
	}
	.preview code {
		font-family: var(--mono);
		font-size: 0.8rem;
		color: var(--accent-2);
	}
	.fields {
		display: grid;
		gap: 16px;
		margin-top: 12px;
		max-width: 560px;
	}
	.fields label > span {
		display: block;
		font-size: 0.86rem;
		margin-bottom: 5px;
	}
	.fields em {
		display: block;
		font-style: normal;
		margin-top: 4px;
	}
	input[type='text'],
	input[type='number'],
	input:not([type]),
	select {
		width: 100%;
		max-width: 320px;
		padding: 8px 11px;
		border-radius: var(--radius-sm);
		border: 1px solid var(--hairline-strong);
		background: var(--bg);
	}
	.check {
		display: flex;
		gap: 10px;
		align-items: flex-start;
	}
	.check input {
		margin-top: 3px;
	}
	.flash {
		padding: 9px 14px;
		border-radius: var(--radius-sm);
		background: rgba(52, 211, 153, 0.12);
		border: 1px solid rgba(52, 211, 153, 0.3);
		font-size: 0.88rem;
	}
	.flash.bad {
		background: rgba(244, 63, 94, 0.12);
		border-color: rgba(244, 63, 94, 0.3);
	}
	.small {
		font-size: 0.8rem;
	}
	.tone-good {
		color: var(--good);
	}
	.tone-warn {
		color: var(--warn);
	}
	.tone-bad {
		color: var(--bad);
	}
	.tone-muted {
		color: var(--text-muted);
	}
</style>
