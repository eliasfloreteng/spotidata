<script lang="ts">
	interface Props {
		src: string | null | undefined;
		alt: string;
		size?: number;
		/** Artists get a circle, everything else a rounded square. */
		round?: boolean;
	}
	let { src, alt, size = 40, round = false }: Props = $props();

	const radius = $derived(round ? '50%' : size > 120 ? '14px' : '6px');
</script>

{#if src}
	<img
		{src}
		{alt}
		width={size}
		height={size}
		loading="lazy"
		decoding="async"
		style="width:{size}px;height:{size}px;border-radius:{radius}"
	/>
{:else}
	<div
		class="placeholder"
		style="width:{size}px;height:{size}px;border-radius:{radius}"
		role="img"
		aria-label="{alt} — no artwork"
	></div>
{/if}

<style>
	img,
	.placeholder {
		display: block;
		flex: none;
		object-fit: cover;
		background: var(--bg-elevated);
		border: 1px solid var(--hairline);
	}
	.placeholder {
		background: linear-gradient(135deg, rgba(124, 58, 237, 0.18), rgba(192, 38, 211, 0.08));
	}
</style>
