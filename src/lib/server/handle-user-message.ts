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
import { streamUserMessage, streamToAgent } from './connectors/registry.ts';
import { resolveMentionedAgents } from './mentions.ts';
import { createPendingApproval, createRoutedApproval, targetsOf } from './approvals.ts';
import { readAutoApprove } from './channel-settings.ts';
import { tryConsumeRoundtrip } from './loop-defence.ts';

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

	// Channels with `settings_channel.auto_approve = true` skip the
	// human-in-the-loop gate for agent-to-agent mentions (ADR-0015).
	// Read once per user-turn — changes mid-stream are not a thing
	// we model, and refreshing the flag per reply would add a DB
	// read into the hot path for no useful semantic.
	const autoApprove = readAutoApprove(args.channel_id);

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
		if (mentioned.length === 0) continue;

		if (autoApprove) {
			await dispatchAutoApprove({
				channelId: args.channel_id,
				messageId: agentRow.id,
				body: reply.body,
				targets: mentioned,
				emit
			});
		} else {
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

/**
 * Auto-approve dispatch path (ADR-0015 §6, wire protocol).
 *
 * Creates a `routed` approval row with `created_via='auto_approve'`,
 * emits the corresponding `approval_created` event (status=`routed`
 * from the start — no `pending` event is ever sent on this path),
 * then fans out `streamToAgent` calls for the mentioned targets.
 *
 * Roundtrip-cap (ADR-0020) is consumed per target up front, mirroring
 * the pre-consumption shape in `handle-approval-decide.ts`. A relayed
 * reply may itself mention yet another agent; the recursion is
 * bounded by (a) the roundtrip cap and (b) `tryConsumeRoundtrip`
 * stopping new dispatches once the cap is hit.
 *
 * Errors in individual relays do not abort the others — `streamToAgent`
 * converts mid-stream errors into an `{ error }` outcome shape, and
 * sync errors are caught here.
 */
async function dispatchAutoApprove(args: {
	channelId: string;
	messageId: string;
	body: string;
	targets: string[];
	emit: Emit;
}): Promise<void> {
	const { channelId, messageId, body, targets, emit } = args;

	// Pre-consume roundtrip slots per target. The same shape as the
	// approval-decide path: deterministic "these N dispatched, the rest
	// were capped" rather than cap-trips mid-stream.
	const dispatchTargets: string[] = [];
	let capHit: { used: number; cap: number } | null = null;
	for (const t of targets) {
		const gate = tryConsumeRoundtrip(channelId);
		if (!gate.allowed) {
			capHit = { used: gate.used, cap: gate.cap };
			break;
		}
		dispatchTargets.push(t);
	}

	// Audit row covers exactly what was actually dispatched. If the cap
	// trips before any target lands, we still write the row so the
	// protocol viewer shows the intent + a same-turn system event
	// explains why no streams followed.
	const approval = createRoutedApproval({
		messageId,
		targets: dispatchTargets,
		createdVia: 'auto_approve'
	});
	emit({
		type: 'approval_created',
		approval: { ...approval, targets: targetsOf(approval) },
		message_id: messageId
	});

	if (capHit) {
		const skipped = targets.length - dispatchTargets.length;
		emit({
			type: 'system',
			body:
				`Roundtrip cap of ${capHit.cap} reached for this channel — ` +
				`${skipped} relay${skipped === 1 ? '' : 's'} skipped. ` +
				`The next user message resets the counter.`
		});
	}

	if (dispatchTargets.length === 0) return;

	const outcomes = await Promise.all(
		dispatchTargets.map(async (targetAgentId) => {
			try {
				return await streamToAgent(
					{ agent_id: targetAgentId, channel_id: channelId, body },
					emit
				);
			} catch (err) {
				return {
					agentId: targetAgentId,
					messageId: '',
					error: (err as Error).message ?? String(err)
				};
			}
		})
	);

	// Per-relay outcome handling mirrors handle-approval-decide.ts:
	// persist the bubble, recurse into nested mentions (which may
	// themselves be auto-approve or pending, depending on what the
	// channel currently has set).
	for (const outcome of outcomes) {
		if ('error' in outcome) {
			if (outcome.messageId === '') {
				emit({
					type: 'system',
					body: `relay to ${outcome.agentId} failed: ${outcome.error}`
				});
			}
			continue;
		}

		const nestedRow = recordAgentMessage({
			id: outcome.messageId,
			channelId,
			body: outcome.body,
			agentId: outcome.agentId,
			tokens: outcome.tokens
		});

		const nestedMentioned = resolveMentionedAgents(channelId, outcome.body).filter(
			(id) => id !== outcome.agentId
		);
		if (nestedMentioned.length === 0) continue;

		// Recurse. The channel is still auto-approve (the user hasn't
		// had a chance to flip it mid-dispatch), so the next hop is
		// also auto-approved — until the roundtrip cap stops the
		// recursion.
		await dispatchAutoApprove({
			channelId,
			messageId: nestedRow.id,
			body: outcome.body,
			targets: nestedMentioned,
			emit
		});
	}
}
