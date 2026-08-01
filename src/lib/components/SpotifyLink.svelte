<script lang="ts">
	import { page } from '$app/state';
	import { spotifyLink, type EntityKind } from '$lib/utils/spotify-uri.ts';

	interface Props {
		kind: EntityKind;
		id: string;
		label?: string;
		compact?: boolean;
	}
	let { kind, id, label = 'Open in Spotify', compact = false }: Props = $props();

	// `uri` (the default) opens the desktop client; `web` opens a browser tab.
	const scheme = $derived(page.data.linkScheme ?? 'uri');
	const href = $derived(spotifyLink(kind, id, scheme));
</script>

<a
	class="spotify"
	class:compact
	{href}
	title={label}
	aria-label={label}
	rel="noreferrer"
	target={scheme === 'web' ? '_blank' : undefined}
>
	<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
		<path
			fill="currentColor"
			d="M12 2a10 10 0 100 20 10 10 0 000-20zm4.586 14.424a.623.623 0 01-.857.207c-2.348-1.435-5.304-1.76-8.785-.964a.623.623 0 11-.277-1.215c3.809-.871 7.077-.496 9.712 1.115a.623.623 0 01.207.857zm1.223-2.722a.78.78 0 01-1.072.257c-2.687-1.652-6.785-2.13-9.965-1.166a.78.78 0 11-.452-1.492c3.632-1.102 8.147-.568 11.232 1.329a.78.78 0 01.257 1.072zm.105-2.835a.935.935 0 01-1.284.31c-3.223-1.914-8.54-2.09-11.617-1.156a.935.935 0 11-.542-1.79c3.532-1.072 9.404-.865 13.115 1.338a.935.935 0 01.328 1.298z"
		/>
	</svg>
	{#if !compact}<span>{label}</span>{/if}
</a>

<style>
	.spotify {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		padding: 7px 14px;
		border-radius: 999px;
		border: 1px solid var(--hairline-strong);
		background: var(--bg-elevated);
		font-size: 0.84rem;
		color: var(--text-muted);
		transition: color 0.15s ease, border-color 0.15s ease;
	}
	.spotify:hover {
		color: #1ed760;
		border-color: rgba(30, 215, 96, 0.4);
	}
	.spotify.compact {
		padding: 4px;
		border: 0;
		background: none;
	}
</style>
