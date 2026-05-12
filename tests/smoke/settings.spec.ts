import { test, expect } from '@playwright/test';

/**
 * Smoke tests for /settings.
 *
 * Why this file exists: PR #77 and PR #79 fixed two bind-layer bugs on the
 * global-settings form that curl + `npm run check` both passed cleanly.
 * Both regressions would have been caught by 30 seconds of browser test
 * driving Save → reload → expect-persistence. This spec is that test, in
 * permanent form.
 *
 * Scope: global settings only for now. Per-channel pane is mostly the same
 * shape but requires a seeded channel — that's a future spec when the
 * test-fixture story is sorted.
 */

test.describe('/settings — global', () => {
	test('Save persists KB-budget edit across reload', async ({ page }) => {
		await page.goto('/settings');

		// Wait for the form to hydrate (Save button exists, even if disabled).
		const saveBtn = page.getByRole('button', { name: /^(Save|Saving…)$/ });
		await expect(saveBtn).toBeVisible();

		// Read the current value, edit it to current+10, save, reload, expect
		// the new value to still be there.
		const input = page.locator('#kb-budget');
		const current = Number(await input.inputValue());
		expect(Number.isFinite(current)).toBe(true);
		const next = current + 10;

		await input.fill(String(next));
		// $derived dirty flag should now flip the Save button enabled.
		await expect(saveBtn).toBeEnabled();

		await saveBtn.click();

		// After save, Save button should be disabled again (form not dirty).
		await expect(saveBtn).toBeDisabled();

		// Reload and assert the value persisted on the wire (not just in
		// local state).
		await page.reload();
		const inputAfter = page.locator('#kb-budget');
		await expect(inputAfter).toHaveValue(String(next));

		// Cleanup: restore the original so re-running the spec is idempotent.
		await inputAfter.fill(String(current));
		const saveBtnAfter = page.getByRole('button', { name: /^(Save|Saving…)$/ });
		await saveBtnAfter.click();
		await expect(saveBtnAfter).toBeDisabled();
	});

	test('Discard reverts an in-progress edit', async ({ page }) => {
		await page.goto('/settings');

		const input = page.locator('#kb-budget');
		const saveBtn = page.getByRole('button', { name: /^(Save|Saving…)$/ });
		const discardBtn = page.getByRole('button', { name: 'Discard' });

		await expect(saveBtn).toBeVisible();
		const original = await input.inputValue();

		// Edit, confirm dirty (Save + Discard both enabled), Discard,
		// confirm value reverts and buttons disable again.
		await input.fill(String(Number(original) + 5));
		await expect(saveBtn).toBeEnabled();
		await expect(discardBtn).toBeEnabled();

		await discardBtn.click();
		await expect(input).toHaveValue(original);
		await expect(saveBtn).toBeDisabled();
		await expect(discardBtn).toBeDisabled();
	});
});
