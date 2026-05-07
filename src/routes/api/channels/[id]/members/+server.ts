/**
 * GET /api/channels/:id/members — agents that are members of a channel.
 *
 * Used by the UI to render names for `sender_id` references and to
 * populate the target picker on approval bubbles.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db/client';
import { agents, channelMembers } from '$lib/server/db/schema';
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
