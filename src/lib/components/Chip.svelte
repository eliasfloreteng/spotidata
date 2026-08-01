<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		tone?: 'neutral' | 'accent' | 'good' | 'warn' | 'bad';
		title?: string;
		children: Snippet;
	}
	let { tone = 'neutral', title, children }: Props = $props();
</script>

<span class="chip {tone}" {title}>{@render children()}</span>

<style>
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 2px 9px;
		border-radius: 999px;
		font-size: 0.73rem;
		line-height: 1.6;
		white-space: nowrap;
		border: 1px solid var(--hairline-strong);
		color: var(--text-muted);
		background: var(--bg-elevated);
	}
	.accent {
		color: #ddd6fe;
		background: var(--accent-soft);
		border-color: rgba(124, 58, 237, 0.4);
	}
	.good {
		color: var(--good);
		background: rgba(52, 211, 153, 0.1);
		border-color: rgba(52, 211, 153, 0.3);
	}
	.warn {
		color: var(--warn);
		background: rgba(251, 191, 36, 0.1);
		border-color: rgba(251, 191, 36, 0.3);
	}
	.bad {
		color: var(--bad);
		background: rgba(244, 63, 94, 0.1);
		border-color: rgba(244, 63, 94, 0.3);
	}
</style>
