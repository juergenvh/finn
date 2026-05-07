/**
 * PATCH /api/messages/:id/visibility   { hidden: boolean }
 *
 * Sets or clears the channel-view grooming flag on a message
 * (issue #15). The row body and other content columns are not
 * touched; only `hidden_at` and `hidden_by` change. See ADR-0004
 * addendum 2026-05-07 for why this mutation is compatible with
 * the append-only stance.
 *
 * Broadcasts a `state_changed` event so other tabs sync.
 */

import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { setMessageVisibility } from '$lib/server/messages';
import { broadcastStateChange } from '$lib/server/ws/attach';
import type { RequestHandler } from './$types';

const Body = z.object({ hidden: z.boolean() });

export const PATCH: RequestHandler = async ({ params, request }) => {
	const raw = await request.json().catch(() => null);
	const parsed = Body.safeParse(raw);
	if (!parsed.success) throw error(400, 'hidden (boolean) required');

	const updated = setMessageVisibility(params.id, parsed.data.hidden);
	if (!updated) throw error(404, 'message not found');

	broadcastStateChange({
		type: 'state_changed',
		entity: 'message',
		action: 'updated',
		id: params.id,
		extra: {
			channel_id: updated.channelId,
			hidden: parsed.data.hidden
		}
	});

	return json({
		id: updated.id,
		hidden_at: updated.hiddenAt,
		hidden_by: updated.hiddenBy
	});
};
