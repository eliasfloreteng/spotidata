<!--
  Sheet — a modal panel that rises from the bottom edge, where a thumb already
  is. A native <dialog> shown with showModal(), so the page behind is inert,
  focus stays inside and Escape closes it without any of that written here.
  Tapping the dimmed page above it closes it too.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';

	interface Props {
		open: boolean;
		title: string;
		children: Snippet;
		/** Extra controls in the header, before the close button. */
		actions?: Snippet;
	}
	let { open = $bindable(), title, children, actions }: Props = $props();

	let dialog = $state<HTMLDialogElement | null>(null);

	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) dialog.showModal();
		else if (!open && dialog.open) dialog.close();
	});

	/** The dialog box itself is only hit outside the panel: on the backdrop. */
	function backdrop(event: MouseEvent) {
		if (event.target === dialog) open = false;
	}
</script>

<dialog
	bind:this={dialog}
	aria-label={title}
	onclose={() => (open = false)}
	onclick={backdrop}
>
	<div class="panel">
		<header>
			<h2>{title}</h2>
			{@render actions?.()}
			<button class="close" type="button" onclick={() => (open = false)} aria-label="Close">
				<Icon name="close" size={18} />
			</button>
		</header>
		<div class="body">
			{@render children()}
		</div>
	</div>
</dialog>

<style>
	dialog {
		/* The dialog is the full-screen hit area; the panel is what shows. */
		position: fixed;
		inset: 0;
		width: 100%;
		max-width: none;
		height: 100%;
		max-height: none;
		margin: 0;
		padding: 0;
		border: 0;
		background: transparent;
		color: inherit;
		display: flex;
		align-items: flex-end;
		justify-content: center;
		overscroll-behavior: contain;
	}
	dialog:not([open]) {
		display: none;
	}
	dialog::backdrop {
		background: rgba(0, 0, 0, 0.55);
	}
	.panel {
		width: 100%;
		max-width: 560px;
		max-height: min(84dvh, 720px);
		display: flex;
		flex-direction: column;
		background: var(--bg-elevated);
		border: 1px solid var(--hairline-strong);
		border-bottom: 0;
		border-radius: 20px 20px 0 0;
		box-shadow: 0 -12px 40px rgba(0, 0, 0, 0.5);
		padding-bottom: env(safe-area-inset-bottom);
		transition: transform 0.32s cubic-bezier(0.22, 1, 0.36, 1);
	}
	@starting-style {
		dialog[open] .panel {
			transform: translateY(100%);
		}
	}
	header {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 14px 10px 10px var(--page-px);
		border-bottom: 1px solid var(--hairline);
	}
	h2 {
		flex: 1;
		font-size: 1.02rem;
	}
	.close {
		display: grid;
		place-items: center;
		width: 40px;
		height: 40px;
		border: 0;
		border-radius: 999px;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}
	.close:active {
		background: rgba(255, 255, 255, 0.06);
	}
	.body {
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: 14px var(--page-px) 18px;
	}
</style>
