declare global {
	namespace App {
		interface Locals {
			/** Resolved once per request in hooks.server.ts. */
			settings: import('./lib/server/settings.ts').Settings;
		}
		interface PageData {}
		interface Error {
			code?: string;
		}
	}
}

export {};
