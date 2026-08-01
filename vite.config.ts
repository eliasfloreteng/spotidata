import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	server: {
		// Bind the loopback IP literal, not `localhost`: the Spotify redirect URI
		// is registered as 127.0.0.1 and the origins must match exactly.
		host: '127.0.0.1',
		port: 5173,
		strictPort: true
	},
	preview: { host: '127.0.0.1', port: 4173, strictPort: true }
});
