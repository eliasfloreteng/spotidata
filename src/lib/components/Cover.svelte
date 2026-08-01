<script lang="ts">
	interface Props {
		src: string | null | undefined;
		alt: string;
		/** Edge length in px, or 'fill' to take the column width as a square. */
		size?: number | 'fill';
		/** Artists get a circle, everything else a rounded square. */
		round?: boolean;
	}
	let { src, alt, size = 40, round = false }: Props = $props();

	const fill = $derived(size === 'fill');
	const radius = $derived(
		round ? '50%' : typeof size === 'number' ? (size > 120 ? '14px' : '6px') : '10px'
	);
	const box = $derived(
		typeof size === 'number' ? `width:${size}px;height:${size}px` : 'width:100%;aspect-ratio:1'
	);
</script>

{#if src}
	<img
		{src}
		{alt}
		width={fill ? undefined : size}
		height={fill ? undefined : size}
		loading="lazy"
		decoding="async"
		style="{box};border-radius:{radius}"
	/>
{:else}
	<div
		class="placeholder"
		style="{box};border-radius:{radius}"
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
