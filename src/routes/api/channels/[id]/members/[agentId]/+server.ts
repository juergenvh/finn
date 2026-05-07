/**
 * DELETE /api/channels/:id/members/:agentId
 *
 * Hard-delete the membership row (per ADR-0004). Past messages from
 * this agent in this channel remain attributable; only the
 * "currently a member" relationship is removed.
 *
 * Emits a system message in the channel.
 */

import { and, eq } from 'drizzle-orm';
import { json, error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db/client';
import { agents, channelMembers, channels } from '$lib/server/db/schema';
import { recordSystemMessage } from '$lib/server/messages';
import { broadcastStateChange, broadcastEvent } from '$lib/server/ws/attach';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = async ({ params }) => {
	const db = getDb();

	const channel = db.select().from(channels).where(eq(channels.id, params.id)).get();
	if (!channel) throw error(404, 'channel not found');

	const member = db
		.select()
		.from(channelMembers)
		.where(
			and(eq(channelMembers.channelId, params.id), eq(channelMembers.agentId, params.agentId))
		)
		.get();
	if (!member) {
		// Idempotent: already not a member.
		return json({ channel_id: params.id, agent_id: params.agentId });
	}

	const agent = db.select().from(agents).where(eq(agents.id, params.agentId)).get();
	const agentName = agent?.name ?? params.agentId;

	db.delete(channelMembers)
		.where(
			and(eq(channelMembers.channelId, params.id), eq(channelMembers.agentId, params.agentId))
		)
		.run();

	const sys = recordSystemMessage({
		channelId: params.id,
		body: `${agentName} left the channel`
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
		action: 'deleted',
		id: params.id,
		extra: { agent_id: params.agentId }
	});

	return json({ channel_id: params.id, agent_id: params.agentId });
};
