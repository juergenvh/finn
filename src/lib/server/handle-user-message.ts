/**
 * Default user-message hook implementation.
 *
 * Streams broadcasts via the `emit` callback as soon as each piece is
 * ready:
 *   1. Persist the user turn → emit it (so the user's bubble appears
 *      immediately, before any connector latency).
 *   2. Fan out to every channel member agent in parallel; for each
 *      reply that arrives, persist it and emit it.
 *   3. For agent replies that mention other agents, create an approval
 *      row and emit `approval_created`.
 *
 * Per ADR-0005: user → agent never needs approval. Agent → agent
 * always does. Agent → user (no `@-mention` to other agents) is
 * persisted but creates no approval row.
 */

import type { Emit, BroadcastMessage } from './ws/attach.ts';
import { recordUserMessage, recordAgentMessage } from './messages.ts';
import { dispatchUserMessage, type DispatchedReply } from './connectors/registry.ts';
import { resolveMentionedAgents } from './mentions.ts';
import { createPendingApproval, targetsOf } from './approvals.ts';

function messageBroadcast(
	row: { id: string; channelId: string; body: string; createdAt: number },
	sender: 'user' | 'agent' | 'system',
	senderId: string | null
): BroadcastMessage {
	return {
		type: 'message',
		channel_id: row.channelId,
		sender,
		sender_id: senderId,
		body: row.body,
		ts: row.createdAt,
		id: row.id
	};
}

export async function handleUserMessage(
	args: { channel_id: string; body: string },
	emit: Emit
): Promise<void> {
	const userRow = recordUserMessage({ channelId: args.channel_id, body: args.body });
	emit(messageBroadcast(userRow, 'user', userRow.senderId ?? 'jurgen'));

	let replies: Array<DispatchedReply | { agentId: string; error: string }>;
	try {
		replies = await dispatchUserMessage({ channel_id: args.channel_id, body: args.body });
	} catch (err) {
		emit({ type: 'system', body: `dispatch error: ${(err as Error).message}` });
		return;
	}

	for (const reply of replies) {
		if ('error' in reply) {
			emit({ type: 'system', body: `agent ${reply.agentId} error: ${reply.error}` });
			continue;
		}

		const agentRow = recordAgentMessage({
			channelId: args.channel_id,
			body: reply.body,
			agentId: reply.agentId
		});
		emit(messageBroadcast(agentRow, 'agent', reply.agentId));

		// Mentions in the agent reply that resolve to OTHER agents in
		// the channel become the default approval target set. The
		// authoring agent itself is excluded — agents do not need
		// approval to "talk to themselves".
		const mentioned = resolveMentionedAgents(args.channel_id, reply.body).filter(
			(id) => id !== reply.agentId
		);
		if (mentioned.length > 0) {
			const approval = createPendingApproval({
				messageId: agentRow.id,
				defaultTargets: mentioned
			});
			emit({
				type: 'approval_created',
				approval: { ...approval, targets: targetsOf(approval) },
				message_id: agentRow.id
			});
		}
	}
}
