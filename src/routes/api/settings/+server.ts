/**
 * GET   /api/settings           — return global settings.
 * GET   /api/settings?channelId=&lt;id&gt;
 *                               — return effective settings for that
 *                                 channel: global merged with the
 *                                 channel-scoped override row.
 * PATCH /api/settings           — update one or more global keys.
 *                                 Body is a partial of the global shape;
 *                                 unspecified keys are left untouched.
 *                                 Broadcasts `state_changed` with
 *                                 entity=`settings`, id=`"global"`.
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
import { z } from 'zod';
import { getDb } from '$lib/server/db/client';
import { settingsGlobal, settingsChannel, channels } from '$lib/server/db/schema';
import { broadcastStateChange } from '$lib/server/ws/attach';
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
			theme: row.theme,
			roundtripCapDefault: row.roundtripCapDefault
		};
	}

	return {
		kbBudgetDefault: 200,
		showGroomedDefault: false,
		hideSystemMessagesDefault: false,
		defaultChannelId: null,
		theme: 'system' as const,
		roundtripCapDefault: 5
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
	const roundtripCapOverride = overrideRow?.roundtripCapOverride ?? null;

	return json({
		global,
		channel: {
			channelId,
			kbBudgetOverride,
			autoApprove,
			roundtripCapOverride,
			effective: {
				kbBudget: kbBudgetOverride ?? global.kbBudgetDefault,
				autoApprove,
				roundtripCap: roundtripCapOverride ?? global.roundtripCapDefault
			}
		}
	});
};

/* ---------------------------------------------------------------- PATCH global */

/**
 * Partial-update schema for the global settings row.
 *
 * Every field is optional; the caller sends only the keys it wants
 * to change. Unknown keys are rejected (`strict()`) so a client-side
 * typo surfaces as 400 rather than a silent no-op.
 *
 * Bounds:
 *  - `kbBudgetDefault` 1..100_000 (KB). Upper bound is a sanity
 *    guard; a budget that large is effectively "no limit" and a
 *    user who really wants it can set it again next year.
 *  - `defaultChannelId` may be null ("no default; use last-active")
 *    or a channel id; the channel must exist.
 */
const UpdateGlobalSchema = z
	.object({
		kbBudgetDefault: z.number().int().min(1).max(100_000).optional(),
		showGroomedDefault: z.boolean().optional(),
		hideSystemMessagesDefault: z.boolean().optional(),
		defaultChannelId: z.string().min(1).nullable().optional(),
		theme: z.enum(['system', 'light', 'dark']).optional(),
		roundtripCapDefault: z.number().int().min(1).max(100).optional()
	})
	.strict();

export const PATCH: RequestHandler = async ({ request }) => {
	const raw = await request.json().catch(() => null);
	const parsed = UpdateGlobalSchema.safeParse(raw);
	if (!parsed.success) {
		throw error(400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
	}
	const body = parsed.data;

	// Empty patch = nothing to do; return current state without writing.
	if (Object.keys(body).length === 0) {
		return json({ global: readGlobal() });
	}

	const db = getDb();

	// Validate defaultChannelId references an existing channel before
	// taking the write. The FK is not enforced at the SQLite level (no
	// `references()` on this column — a channel can be soft-deleted
	// without invalidating the setting), so the application owns the
	// check.
	if (body.defaultChannelId) {
		const exists = db
			.select({ id: channels.id })
			.from(channels)
			.where(eq(channels.id, body.defaultChannelId))
			.get();
		if (!exists) {
			throw error(400, `defaultChannelId: channel ${body.defaultChannelId} not found`);
		}
	}

	db.update(settingsGlobal)
		.set({ ...body, updatedAt: Date.now() })
		.where(eq(settingsGlobal.id, 1))
		.run();

	broadcastStateChange({
		type: 'state_changed',
		entity: 'settings',
		action: 'updated',
		id: 'global'
	});

	return json({ global: readGlobal() });
};
