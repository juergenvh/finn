/**
 * Helper: resolve the (single) agent member of a channel.
 *
 * Spike-only. When multi-agent channels arrive, the caller becomes
 * responsible for attributing each reply to the agent that produced it
 * (and the approval flow becomes the routing layer).
 */

import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from './db/client.ts';
import { agents, channelMembers } from './db/schema.ts';

export function agentForChannel(channelId: string): string {
	const db = getDb();
	const rows = db
		.select({ id: agents.id })
		.from(channelMembers)
		.innerJoin(agents, eq(channelMembers.agentId, agents.id))
		.where(
			and(
				eq(channelMembers.channelId, channelId),
				isNull(agents.deletedAt),
				eq(agents.enabled, true)
			)
		)
		.all();
	if (rows.length !== 1) {
		throw new Error(
			`agentForChannel(${channelId}): expected exactly 1 enabled agent, got ${rows.length}`
		);
	}
	return rows[0]!.id;
}
