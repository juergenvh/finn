/**
 * PATCH /api/settings/channel/&lt;id&gt;  — update per-channel overrides.
 *   Body is a partial of {kbBudgetOverride, autoApprove}.
 *   `kbBudgetOverride` may be null (= clear the override, inherit
 *   global). Passing an empty body is a no-op and 200s.
 *   Upserts the row (creates it on first override; subsequent
 *   PATCHes update). Broadcasts `state_changed` with
 *   entity=`settings`, id=channel-id.
 *
 * DELETE /api/settings/channel/&lt;id&gt; — delete the override row entirely.
 *   Useful for "reset to global defaults" actions. Idempotent: a
 *   missing row is treated as success.
 *
 * No auth (single-user; see ADR-0001).
 */

import { eq } from 'drizzle-orm';
import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db/client';
import { settingsChannel, channels } from '$lib/server/db/schema';
import { broadcastStateChange } from '$lib/server/ws/attach';
import type { RequestHandler } from './$types';

const UpdateChannelSchema = z
	.object({
		kbBudgetOverride: z.number().int().min(1).max(100_000).nullable().optional(),
		autoApprove: z.boolean().optional(),
		roundtripCapOverride: z.number().int().min(1).max(100).nullable().optional()
	})
	.strict();

function assertChannelExists(channelId: string) {
	const db = getDb();
	const row = db
		.select({ id: channels.id })
		.from(channels)
		.where(eq(channels.id, channelId))
		.get();
	if (!row) {
		throw error(404, `channel ${channelId} not found`);
	}
}

export const PATCH: RequestHandler = async ({ params, request }) => {
	const channelId = params.id;
	if (!channelId) throw error(400, 'channel id required');
	assertChannelExists(channelId);

	const raw = await request.json().catch(() => null);
	const parsed = UpdateChannelSchema.safeParse(raw);
	if (!parsed.success) {
		throw error(
			400,
			parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
		);
	}
	const body = parsed.data;

	const db = getDb();
	const now = Date.now();

	// Read the existing override row (if any) so we can do a stable
	// upsert without trashing fields the caller didn't touch.
	const existing = db
		.select()
		.from(settingsChannel)
		.where(eq(settingsChannel.channelId, channelId))
		.get();

	if (Object.keys(body).length === 0) {
		// Empty patch — return current state without writing.
		return json({
			channelId,
			kbBudgetOverride: existing?.kbBudgetOverride ?? null,
			autoApprove: existing?.autoApprove ?? false,
			roundtripCapOverride: existing?.roundtripCapOverride ?? null
		});
	}

	if (existing) {
		db.update(settingsChannel)
			.set({ ...body, updatedAt: now })
			.where(eq(settingsChannel.channelId, channelId))
			.run();
	} else {
		db.insert(settingsChannel)
			.values({
				channelId,
				kbBudgetOverride: body.kbBudgetOverride ?? null,
				autoApprove: body.autoApprove ?? false,
				roundtripCapOverride: body.roundtripCapOverride ?? null,
				updatedAt: now
			})
			.run();
	}

	broadcastStateChange({
		type: 'state_changed',
		entity: 'settings',
		action: existing ? 'updated' : 'created',
		id: channelId
	});

	const after = db
		.select()
		.from(settingsChannel)
		.where(eq(settingsChannel.channelId, channelId))
		.get();

	return json({
		channelId,
		kbBudgetOverride: after?.kbBudgetOverride ?? null,
		autoApprove: after?.autoApprove ?? false,
		roundtripCapOverride: after?.roundtripCapOverride ?? null
	});
};

export const DELETE: RequestHandler = async ({ params }) => {
	const channelId = params.id;
	if (!channelId) throw error(400, 'channel id required');
	assertChannelExists(channelId);

	const db = getDb();
	const existed = db
		.select({ channelId: settingsChannel.channelId })
		.from(settingsChannel)
		.where(eq(settingsChannel.channelId, channelId))
		.get();

	db.delete(settingsChannel).where(eq(settingsChannel.channelId, channelId)).run();

	// Only broadcast if a row actually existed; deleting a non-existent
	// row is idempotent but produces no observable state change.
	if (existed) {
		broadcastStateChange({
			type: 'state_changed',
			entity: 'settings',
			action: 'deleted',
			id: channelId
		});
	}

	return json({ channelId, deleted: !!existed });
};
