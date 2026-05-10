import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration.
 *
 * Kept separate from `vite.config.ts` so the SvelteKit/dev plugins
 * don't run during unit tests (faster startup, fewer surprises).
 *
 * Test placement convention:
 *   `tests/unit/<area>.test.ts` — pure-function and module-level
 *   unit tests. No DB, no network, no SvelteKit runtime.
 *
 * When component/integration tests arrive they get their own
 * directory (`tests/component/`, `tests/integration/`) and config
 * extension; not in scope today.
 */
export default defineConfig({
	test: {
		include: ['tests/unit/**/*.test.ts'],
		environment: 'node',
		// Test files import server-side TS modules directly. They use
		// `.ts` extensions (project convention with `"type": "module"`
		// and Vite's resolver). No extra alias needed; the relative
		// imports do the work.
		passWithNoTests: false
	}
});
