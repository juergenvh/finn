/**
 * Default user-message hook implementation.
 *
 * Streams broadcasts via the `emit` callback as soon as each piece is
 * ready:
 *   1. Persist the user turn → emit it (so the user's bubble appears
 *      immediately, before any connector latency).
 *   2. Dispatch to channel-member agents (narrowed to mentioned
 *      agents if the body contains `@-mentions`, see issue #27);
 *      for each reply that arrives, persist it and emit it.
 *   3. For agent replies that mention other agents, create an approval
 *      row and emit `approval_created`.
 *
 * Per ADR-0005: user → agent never needs approval. Agent → agent
 * always does. Agent → user (no `@-mention` to other agents) is
 * persisted but creates no approval row.
 */

import type { Emit, BroadcastMessage } from './ws/attach.ts';
import { recordUserMessage, recordAgentMessage } from './messages.ts';
import { dispatchUserMessage, type DispatchResult } from './connectors/registry.ts';
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

	let result: DispatchResult;
	try {
		result = await dispatchUserMessage({ channel_id: args.channel_id, body: args.body });
	} catch (err) {
		emit({ type: 'system', body: `dispatch error: ${(err as Error).message}` });
		return;
	}

	// Surface mention diagnostics. Two cases worth telling the user:
	//   1) They mentioned something that does not match any channel
	//      member — we silently dropped it; warn so they know.
	//   2) They mentioned only non-members — nothing was dispatched
	//      at all; tell them explicitly because the absence of replies
	//      otherwise looks like the agents went silent.
	if (result.diagnostics.unresolvedMentionTokens.length > 0) {
		const unresolved = result.diagnostics.unresolvedMentionTokens
			.map((t) => `@${t}`)
			.join(', ');
		if (result.replies.length === 0) {
			emit({
				type: 'system',
				body: `${unresolved} not in this channel — no agent was dispatched.`
			});
		} else {
			emit({
				type: 'system',
				body: `${unresolved} not in this channel — dispatched only the resolved mentions.`
			});
		}
	}

	for (const reply of result.replies) {
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
