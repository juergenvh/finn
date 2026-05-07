/**
 * GET  /api/channels/:id/members           — list active members
 * POST /api/channels/:id/members           — add a member; body: { agent_id }
 *
 * Adding a member emits a system message in the channel so participants
 * see who joined.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db/client';
import { agents, channelMembers, channels } from '$lib/server/db/schema';
import { recordSystemMessage } from '$lib/server/messages';
import { broadcastStateChange, broadcastEvent } from '$lib/server/ws/attach';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	const db = getDb();
	const rows = db
		.select({
			id: agents.id,
			name: agents.name,
			connectorType: agents.connectorType,
			enabled: agents.enabled
		})
		.from(channelMembers)
		.innerJoin(agents, eq(channelMembers.agentId, agents.id))
		.where(and(eq(channelMembers.channelId, params.id), isNull(agents.deletedAt)))
		.all();
	return json({ members: rows });
};

const AddSchema = z.object({ agent_id: z.string().min(1) });

export const POST: RequestHandler = async ({ params, request }) => {
	const raw = await request.json().catch(() => null);
	const parsed = AddSchema.safeParse(raw);
	if (!parsed.success) throw error(400, 'agent_id required');
	const { agent_id } = parsed.data;

	const db = getDb();

	const channel = db
		.select()
		.from(channels)
		.where(and(eq(channels.id, params.id), isNull(channels.deletedAt)))
		.get();
	if (!channel) throw error(404, 'channel not found or archived');

	const agent = db
		.select()
		.from(agents)
		.where(and(eq(agents.id, agent_id), isNull(agents.deletedAt)))
		.get();
	if (!agent) throw error(404, 'agent not found or archived');

	const exists = db
		.select()
		.from(channelMembers)
		.where(
			and(eq(channelMembers.channelId, params.id), eq(channelMembers.agentId, agent_id))
		)
		.get();
	if (exists) {
		return json({ channel_id: params.id, agent_id });
	}

	db.insert(channelMembers)
		.values({ channelId: params.id, agentId: agent_id, joinedAt: Date.now() })
		.run();

	const sys = recordSystemMessage({
		channelId: params.id,
		body: `${agent.name} joined the channel`
	});
	broadcastEvent({
		type: 'message',
		channel_id: sys.channelId,
		sender: 'system',
		sender_id: null,
		body: sys.body,
		ts: sys.createdAt,
		id: sys.id
	});
	broadcastStateChange({
		type: 'state_changed',
		entity: 'channel_member',
		action: 'created',
		id: params.id,
		extra: { agent_id }
	});

	return json({ channel_id: params.id, agent_id }, { status: 201 });
};
