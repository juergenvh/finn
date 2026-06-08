/**
 * Server-side hooks — security response headers (issue #106).
 *
 * CSP itself is configured in svelte.config.js (kit.csp) so SvelteKit can
 * inject the per-request nonce into its own hydration scripts automatically.
 * The headers below are companions that do not need nonce handling:
 *
 * - X-Content-Type-Options: nosniff   — prevent MIME-sniffing attacks
 * - X-Frame-Options: DENY             — clickjacking protection for older browsers
 *                                       (CSP frame-ancestors: none covers modern ones)
 * - Referrer-Policy                   — limit referrer leakage on navigation
 * - Permissions-Policy                — deny sensitive browser APIs finn does not use
 */

import type { Handle } from '@sveltejs/kit';

export const handle: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);

	// Prevent MIME-type sniffing (e.g. serving a .txt file as script).
	response.headers.set('X-Content-Type-Options', 'nosniff');

	// Clickjacking protection for browsers that predate CSP frame-ancestors.
	response.headers.set('X-Frame-Options', 'DENY');

	// Send origin only on same-origin requests; strip referrer on cross-origin.
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

	// Deny all sensitive browser capabilities finn does not use.
	response.headers.set(
		'Permissions-Policy',
		'geolocation=(), camera=(), microphone=(), payment=()'
	);

	return response;
};
