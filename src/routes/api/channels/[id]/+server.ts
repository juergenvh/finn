/**
 * PATCH  /api/channels/:id   — update name / description.
 * DELETE /api/channels/:id   — soft-delete (sets deleted_at).
 *
 * Per ADR-0004, channels are soft-delete: deleted_at is set, the row
 * stays. Past messages remain attributable. A user can restore by
 * clearing deleted_at via SQL (no UI for restore yet).
 */

import { eq } from 'drizzle-orm';
import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db/client';
import { channels } from '$lib/server/db/schema';
import { broadcastStateChange } from '$lib/server/ws/attach';
import type { RequestHandler } from './$types';

const PatchSchema = z.object({
	name: z.string().trim().min(1).max(80).optional(),
	description: z.string().trim().max(500).nullable().optional()
});

export const PATCH: RequestHandler = async ({ params, request }) => {
	const raw = await request.json().catch(() => null);
	const parsed = PatchSchema.safeParse(raw);
	if (!parsed.success) {
		throw error(400, parsed.error.issues[0]?.message ?? 'invalid body');
	}
	const updates = parsed.data;
	if (Object.keys(updates).length === 0) {
		throw error(400, 'no fields to update');
	}

	const db = getDb();
	const existing = db.select().from(channels).where(eq(channels.id, params.id)).get();
	if (!existing) throw error(404, 'channel not found');
	if (existing.deletedAt !== null) throw error(410, 'channel is archived');

	// Uniqueness check on rename
	if (updates.name && updates.name !== existing.name) {
		const clash = db
			.select({ id: channels.id })
			.from(channels)
			.where(eq(channels.name, updates.name))
			.all();
		if (clash.some((c) => c.id !== params.id)) {
			throw error(409, `channel name '${updates.name}' already exists`);
		}
	}

	const next: Partial<typeof existing> = {};
	if (updates.name !== undefined) next.name = updates.name;
	if (updates.description !== undefined) next.description = updates.description;
	db.update(channels).set(next).where(eq(channels.id, params.id)).run();

	broadcastStateChange({ type: 'state_changed', entity: 'channel', action: 'updated', id: params.id });
	return json({ id: params.id, ...next });
};

export const DELETE: RequestHandler = async ({ params }) => {
	const db = getDb();
	const existing = db.select().from(channels).where(eq(channels.id, params.id)).get();
	if (!existing) throw error(404, 'channel not found');
	if (existing.deletedAt !== null) {
		// Already archived — idempotent success.
		return json({ id: params.id, deleted_at: existing.deletedAt });
	}

	const now = Date.now();
	db.update(channels).set({ deletedAt: now }).where(eq(channels.id, params.id)).run();

	broadcastStateChange({ type: 'state_changed', entity: 'channel', action: 'deleted', id: params.id });
	return json({ id: params.id, deleted_at: now });
};
