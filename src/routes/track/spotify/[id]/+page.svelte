<script lang="ts">
	import PendingEntity from '$lib/components/PendingEntity.svelte';

	let { data } = $props();
</script>

<svelte:head><title>Resolving track · Spotidata</title></svelte:head>

<h1>Resolving track</h1>
<p class="muted sub">Looking up which recording <span class="mono">{data.id}</span> belongs to.</p>

<PendingEntity kind="track" id={data.id} />

<style>
	.sub {
		margin: 6px 0 var(--gap);
		font-size: 0.9rem;
	}
	.mono {
		font-family: var(--mono);
	}
</style>
