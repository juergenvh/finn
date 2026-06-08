import adapter from '@sveltejs/adapter-node';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		adapter: adapter(),

		// Content-Security-Policy (issue #106, companion to ADR-0023).
		// mode:'nonce' makes SvelteKit inject the nonce into its own hydration
		// scripts automatically; no manual %sveltekit.nonce% required.
		csp: {
			mode: 'nonce',
			directives: {
				'default-src': ['self'],
				// 'self' covers same-origin scripts; nonce covers SvelteKit
				// hydration inline scripts injected at render time.
				'script-src': ['self'],
				// 'unsafe-inline' for styles: SvelteKit scoped CSS and a small
				// number of inline style attributes (e.g. display:contents in
				// app.html, dynamic width/height in UI components). Lower risk
				// than unsafe-inline for scripts.
				'style-src': ['self', 'unsafe-inline'],
				// 'self' for static assets (favicon.svg, etc.).
				// 'https:' allows agent-emitted HTTPS image URLs per ADR-0023.
				// 'data:' covers SVG favicons and any data-URI images.
				'img-src': ['self', 'https:', 'data:'],
				// 'self' covers same-origin WebSocket (ws:// in dev, wss:// in
				// prod) per CSP Level 2 same-origin matching.
				'connect-src': ['self'],
				'font-src': ['self'],
				// Allow blob: workers — Vite's HMR client creates a blob: worker
				// when polling for reconnect after a connection loss. Without this,
				// 'script-src' is used as fallback and blocks the blob: URL, leaving
				// the page in a broken state (textarea unresponsive) after inactivity.
				'worker-src': ['self', 'blob:'],
				// Deny all plugin content.
				'object-src': ['none'],
				// Restrict base element to same origin.
				'base-uri': ['self'],
				// Restrict form submissions to same origin.
				'form-action': ['self'],
				// Deny embedding in frames/iframes (clickjacking protection).
				'frame-ancestors': ['none']
			}
		}
	}
};

export default config;
