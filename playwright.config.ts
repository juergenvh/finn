import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright smoke-test configuration.
 *
 * Purpose: catch browser-side bind-layer regressions that curl + `npm run
 * check` can't see. Background, see lessons.md "Curl-Acceptance ist nicht
 * genug für UI-Forms" and PR #77 / #79.
 *
 * Scope: smoke only. These are *not* a full e2e suite. Each spec exercises
 * one user-visible flow on one route and asserts state-after, not pixels.
 * Slow specs or per-PR exhaustive coverage do not belong here — they'd
 * defeat the purpose of a pre-merge gate.
 *
 * Run locally:
 *   npm run dev                   # in one terminal
 *   npm run test:smoke            # in another
 *
 * Or one-shot (Playwright starts/stops the dev server itself):
 *   npm run test:smoke
 *
 * The webServer block below boots `npm run dev` automatically. If the dev
 * server is already running on :5173, Playwright reuses it
 * (`reuseExistingServer: true`).
 */
export default defineConfig({
	testDir: './tests/smoke',
	timeout: 30_000,
	expect: { timeout: 5_000 },
	fullyParallel: false, // smoke runs are short; serial keeps DB state legible
	forbidOnly: !!process.env.CI,
	retries: 0,
	workers: 1,
	reporter: process.env.CI ? 'list' : 'list',
	use: {
		baseURL: 'http://localhost:5173',
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
		video: 'off'
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	webServer: {
		command: 'npm run dev',
		url: 'http://localhost:5173',
		reuseExistingServer: !process.env.CI,
		timeout: 60_000,
		stdout: 'pipe',
		stderr: 'pipe'
	}
});
