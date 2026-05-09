/**
 * Default user-message hook implementation.
 *
 * Streams broadcasts via the `emit` callback as soon as each piece is
 * ready:
 *   1. Persist the user turn → emit it as a `message` event (the
 *      user message is not streamed; it arrives whole from the form).
 *   2. Stream-dispatch to channel-member agents (narrowed to mentioned
 *      agents if the body contains `@-mentions`, see issue #27).
 *      Each agent emits its own
 *      `message_start` / `message_delta` / `message_end` lifecycle
 *      (ADR-0013); per-agent dispatchers run in parallel so the user
 *      sees fast agents replying while slower ones are still
 *      streaming.
 *   3. On `message_end`, persist the agent reply and create an
 *      approval row when the reply mentions other agents.
 *      `message_error` paths are surfaced via the dispatcher's
 *      per-agent emit; no row is written on failure.
 *
 * Per ADR-0005: user → agent never needs approval. Agent → agent
 * always does. Agent → user (no `@-mention` to other agents) is
 * persisted but creates no approval row.
 */

import type { Emit, BroadcastMessage } from './ws/attach.ts';
import { recordUserMessage, recordAgentMessage } from './messages.ts';
import { streamUserMessage } from './connectors/registry.ts';
import { resolveMentionedAgents } from './mentions.ts';
import { createPendingApproval, targetsOf } from './approvals.ts';

function userMessageBroadcast(
	row: { id: string; channelId: string; body: string; createdAt: number },
	senderId: string
): BroadcastMessage {
	return {
		type: 'message',
		channel_id: row.channelId,
		sender: 'user',
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
	emit(userMessageBroadcast(userRow, userRow.senderId ?? 'jurgen'));

	let result: Awaited<ReturnType<typeof streamUserMessage>>;
	try {
		result = await streamUserMessage(
			{ channel_id: args.channel_id, body: args.body },
			emit
		);
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
			// `streamUserMessage` already emitted `message_error` for
			// the per-agent path. The client handles it directly
			// (failed-bubble UX); no DB row is written and no
			// additional system event is needed.
			continue;
		}

		// Persist the completed stream as one row, using the message id
		// the dispatcher already announced via `message_start`. The
		// client reconciles its in-flight buffer on `message_end`; no
		// legacy `message` event is emitted (phase 2b).
		const agentRow = recordAgentMessage({
			id: reply.messageId,
			channelId: args.channel_id,
			body: reply.body,
			agentId: reply.agentId,
			tokens: reply.tokens
		});

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
