/**
 * GET  /api/channels         — list non-deleted channels.
 * POST /api/channels         — create channel; body: { name, description?, member_agent_ids[] }
 *
 * No auth (single-user; see ADR-0001).
 */

import { isNull, eq } from 'drizzle-orm';
import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db/client';
import { channels, channelMembers, agents } from '$lib/server/db/schema';
import { newId } from '$lib/server/db/ids';
import { broadcastStateChange } from '$lib/server/ws/attach';
import { recordSystemMessage } from '$lib/server/messages';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	const db = getDb();
	const rows = db
		.select({
			id: channels.id,
			name: channels.name,
			description: channels.description
		})
		.from(channels)
		.where(isNull(channels.deletedAt))
		.all();
	// Sort by name on the server so every client surface (channel
	// view, settings rail, protocol filter) sees the same order
	// without having to duplicate the sort logic (issue #92).
	// localeCompare keeps it stable across diacritics; matches the
	// previous client-side sort in settings/+page.svelte.
	rows.sort((a, b) => a.name.localeCompare(b.name));
	return json({ channels: rows });
};

const CreateChannelSchema = z.object({
	name: z.string().trim().min(1).max(80),
	description: z.string().trim().max(500).nullable().optional(),
	member_agent_ids: z.array(z.string().min(1)).default([])
});

export const POST: RequestHandler = async ({ request }) => {
	const raw = await request.json().catch(() => null);
	const parsed = CreateChannelSchema.safeParse(raw);
	if (!parsed.success) {
		throw error(400, parsed.error.issues[0]?.message ?? 'invalid body');
	}
	const { name, description, member_agent_ids } = parsed.data;

	const db = getDb();

	// Uniqueness on name across non-deleted channels.
	const existing = db
		.select({ id: channels.id })
		.from(channels)
		.where(eq(channels.name, name))
		.all();
	if (existing.some(() => true)) {
		throw error(409, `channel name '${name}' already exists`);
	}

	// All requested members must exist and not be soft-deleted.
	if (member_agent_ids.length > 0) {
		const valid = db
			.select({ id: agents.id })
			.from(agents)
			.where(isNull(agents.deletedAt))
			.all();
		const validIds = new Set(valid.map((a) => a.id));
		for (const mid of member_agent_ids) {
			if (!validIds.has(mid)) throw error(400, `unknown agent: ${mid}`);
		}
	}

	const id = newId('channel');
	const now = Date.now();
	db.insert(channels)
		.values({ id, name, description: description ?? null, createdAt: now })
		.run();

	for (const agentId of member_agent_ids) {
		db.insert(channelMembers)
			.values({ channelId: id, agentId, joinedAt: now })
			.run();
	}

	broadcastStateChange({ type: 'state_changed', entity: 'channel', action: 'created', id });
	for (const agentId of member_agent_ids) {
		broadcastStateChange({
			type: 'state_changed',
			entity: 'channel_member',
			action: 'created',
			id,
			extra: { agent_id: agentId }
		});
	}

	return json({ id, name, description: description ?? null }, { status: 201 });
};
