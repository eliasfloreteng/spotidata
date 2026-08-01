<script lang="ts">
	import type { ArtistRef } from '$lib/types.ts';

	interface Props {
		artists: ArtistRef[];
		fallback?: string;
		/** Wider separator for the hero credit lines. */
		dot?: boolean;
	}
	let { artists, fallback = '—', dot = false }: Props = $props();
</script>

{#if artists.length === 0}<span class="faint">{fallback}</span>{/if}{#each artists as a, i (a.id)}<a
		href="/artist/{a.id}">{a.name}</a
	>{#if i < artists.length - 1}<span class="sep">{dot ? ' · ' : ', '}</span>{/if}{/each}

<style>
	a:hover {
		text-decoration: underline;
	}
	.sep {
		color: var(--text-faint);
		white-space: pre;
	}
</style>
