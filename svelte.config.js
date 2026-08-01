import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
export default {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter(),
		// The app is only ever reached over the loopback address, and Spotify
		// forbids `localhost` as a redirect URI — so the origin is always the IP
		// literal. Teach the CSRF check about it or form actions 403 in dev.
		csrf: { trustedOrigins: ['http://127.0.0.1:5173', 'http://127.0.0.1:4173'] }
	}
};
