<!--
  Icon — the app's few drawn glyphs, one stroke weight on a 24px grid. Used by
  the phone's tab bar and sheets, where a word alone is too wide a target.
-->
<script lang="ts" module>
	const PATHS = {
		overview: 'M3 12h4l3-8 4 16 3-8h4',
		library: 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
		artists:
			'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3',
		albums: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM14.5 12a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z',
		playlists: 'M3 6h11M3 11h11M3 16h7M20 4v11.5M20 15.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z',
		dj: 'M3 18v-6a9 9 0 0 1 18 0v6M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z',
		automations: 'M13 2 3 14h9l-1 8 10-12h-9l1-8z',
		log: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM12 7v5l3 2',
		import: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 8l5-5 5 5M12 3v12',
		sync: 'M21 12a9 9 0 0 1-15.4 6.4L3 16M3 12a9 9 0 0 1 15.4-6.4L21 8M21 3v5h-5M3 21v-5h5',
		settings: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
		more: 'M5 12h.01M12 12h.01M19 12h.01',
		filter: 'M22 3H2l8 9.46V19l4 2v-8.54L22 3z',
		sort: 'M3 6h18M6 12h12M10 18h4',
		close: 'M18 6 6 18M6 6l12 12',
		chevron: 'm9 18 6-6-6-6'
	} as const;
	export type IconName = keyof typeof PATHS;
</script>

<script lang="ts">
	interface Props {
		name: IconName;
		size?: number;
	}
	let { name, size = 20 }: Props = $props();
</script>

<svg
	viewBox="0 0 24 24"
	width={size}
	height={size}
	fill="none"
	stroke="currentColor"
	stroke-width={name === 'more' ? 3 : 1.8}
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
>
	<path d={PATHS[name]} />
</svg>

<style>
	svg {
		display: block;
		flex: none;
	}
</style>
