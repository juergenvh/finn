/**
 * Default user-message hook implementation.
 *
 * 1. Persist the user turn.
 * 2. Fan out to every channel member agent.
 * 3. For each reply: persist the agent message, parse `@-mentions`,
 *    create an approval row (pending) if there are agent targets.
 * 4. Return broadcast payloads to attach.ts.
 *
 * Per ADR-0005: user → agent never needs approval. Agent → agent
 * always does. agent → user (no `@-mention` to other agents) is
 * persisted but creates no approval row — the user is the recipient.
 */

import type {
	UserMessageResult,
	BroadcastMessage,
	BroadcastApprovalCreated
} from './ws/attach.ts';
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

export async function handleUserMessage(args: {
	channel_id: string;
	body: string;
}): Promise<UserMessageResult> {
	const userRow = recordUserMessage({ channelId: args.channel_id, body: args.body });
	const result: UserMessageResult = {
		broadcasts: [messageBroadcast(userRow, 'user', userRow.senderId ?? 'jurgen')]
	};

	let replies: Array<DispatchedReply | { agentId: string; error: string }>;
	try {
		replies = await dispatchUserMessage({ channel_id: args.channel_id, body: args.body });
	} catch (err) {
		result.broadcasts.push({
			type: 'system',
			body: `dispatch error: ${(err as Error).message}`
		});
		return result;
	}

	for (const reply of replies) {
		if ('error' in reply) {
			result.broadcasts.push({
				type: 'system',
				body: `agent ${reply.agentId} error: ${reply.error}`
			});
			continue;
		}

		const agentRow = recordAgentMessage({
			channelId: args.channel_id,
			body: reply.body,
			agentId: reply.agentId
		});
		result.broadcasts.push(messageBroadcast(agentRow, 'agent', reply.agentId));

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
			const evt: BroadcastApprovalCreated = {
				type: 'approval_created',
				approval: { ...approval, targets: targetsOf(approval) },
				message_id: agentRow.id
			};
			result.broadcasts.push(evt);
		}
	}

	return result;
}
