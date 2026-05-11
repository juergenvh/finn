/**
 * GET /api/settings           — return global settings.
 * GET /api/settings?channelId=&lt;id&gt;
 *                             — return effective settings for that
 *                               channel: global merged with the
 *                               channel-scoped override row.
 *
 * Write endpoints (PATCH) ship in PR 2; this PR is read-only to prove
 * the wire (ADR-0019 implementation plan).
 *
 * No auth (single-user; see ADR-0001).
 *
 * Shape returned:
 * ```ts
 * {
 *   global: {
 *     kbBudgetDefault: number,
 *     showGroomedDefault: boolean,
 *     hideSystemMessagesDefault: boolean,
 *     defaultChannelId: string | null,
 *     theme: 'system' | 'light' | 'dark'
 *   },
 *   channel?: {                  // only when ?channelId= was provided
 *     channelId: string,
 *     kbBudgetOverride: number | null,
 *     autoApprove: boolean,
 *     // Effective values after applying the override on top of global:
 *     effective: {
 *       kbBudget: number,
 *       autoApprove: boolean
 *     }
 *   }
 * }
 * ```
 */

import { eq } from 'drizzle-orm';
import { json, error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db/client';
import { settingsGlobal, settingsChannel, channels } from '$lib/server/db/schema';
import type { RequestHandler } from './$types';

/**
 * Read the singleton global-settings row. If the seed migration ran
 * the row exists at `id = 1`; if for any reason it does not (e.g.
 * a hand-edited DB), we fall back to the hardcoded defaults rather
 * than 500. Defensive: ADR-0019 promises precedence
 * `channel → global → compiled default`, and "global row missing"
 * should still degrade to "compiled default".
 */
function readGlobal() {
	const db = getDb();
	const row = db
		.select()
		.from(settingsGlobal)
		.where(eq(settingsGlobal.id, 1))
		.get();

	if (row) {
		return {
			kbBudgetDefault: row.kbBudgetDefault,
			showGroomedDefault: row.showGroomedDefault,
			hideSystemMessagesDefault: row.hideSystemMessagesDefault,
			defaultChannelId: row.defaultChannelId,
			theme: row.theme
		};
	}

	return {
		kbBudgetDefault: 200,
		showGroomedDefault: false,
		hideSystemMessagesDefault: false,
		defaultChannelId: null,
		theme: 'system' as const
	};
}

export const GET: RequestHandler = async ({ url }) => {
	const db = getDb();
	const global = readGlobal();

	const channelId = url.searchParams.get('channelId');
	if (!channelId) {
		return json({ global });
	}

	// Verify the channel exists so a typo'd id doesn't silently return
	// a phantom override-row of all-nulls.
	const channelRow = db
		.select({ id: channels.id })
		.from(channels)
		.where(eq(channels.id, channelId))
		.get();
	if (!channelRow) {
		throw error(404, `channel ${channelId} not found`);
	}

	const overrideRow = db
		.select()
		.from(settingsChannel)
		.where(eq(settingsChannel.channelId, channelId))
		.get();

	const kbBudgetOverride = overrideRow?.kbBudgetOverride ?? null;
	const autoApprove = overrideRow?.autoApprove ?? false;

	return json({
		global,
		channel: {
			channelId,
			kbBudgetOverride,
			autoApprove,
			effective: {
				kbBudget: kbBudgetOverride ?? global.kbBudgetDefault,
				autoApprove
			}
		}
	});
};
