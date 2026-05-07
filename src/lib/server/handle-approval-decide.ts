/**
 * Handle a user's approval/reject decision.
 *
 * Streams broadcasts via `emit`:
 *   1. Update the approval row → emit `approval_updated`.
 *   2. (Approve only) For each target in parallel: dispatch the
 *      original message, persist the reply, emit it, and emit any
 *      derivative `approval_created` if the reply mentions another
 *      agent.
 *   3. Mark the approval `routed` once all target dispatches are
 *      done → emit `approval_updated`.
 *
 * Reject path: emit the `approval_updated` (rejected) and stop.
 *
 * Per ADR-0005: the recursion (a relayed reply may itself mention
 * yet another agent and create a fresh pending approval) is bounded
 * by the channel-member set and human-paced by the approval gate,
 * so spirals are structurally impossible.
 */

import { eq } from 'drizzle-orm';
import { getDb } from './db/client.ts';
import { messages } from './db/schema.ts';
import {
	decideApproval,
	markRouted,
	createPendingApproval,
	targetsOf,
	type ApprovalDecision
} from './approvals.ts';
import { recordAgentMessage } from './messages.ts';
import { dispatchToAgent } from './connectors/registry.ts';
import { resolveMentionedAgents } from './mentions.ts';
import type { Emit, BroadcastMessage } from './ws/attach.ts';

function messageBroadcast(
	row: { id: string; channelId: string; body: string; createdAt: number },
	senderId: string
): BroadcastMessage {
	return {
		type: 'message',
		channel_id: row.channelId,
		sender: 'agent',
		sender_id: senderId,
		body: row.body,
		ts: row.createdAt,
		id: row.id
	};
}

export type ApprovalDecideArgs = {
	approval_id: string;
	decision: 'approve' | 'reject';
	targets?: string[];
	reject_reason?: string;
};

export async function handleApprovalDecide(args: ApprovalDecideArgs, emit: Emit): Promise<void> {
	const decision: ApprovalDecision =
		args.decision === 'approve'
			? { decision: 'approve', targets: args.targets ?? [] }
			: { decision: 'reject', reason: args.reject_reason };

	const updated = decideApproval(args.approval_id, decision);
	emit({
		type: 'approval_updated',
		approval: { ...updated, targets: targetsOf(updated) }
	});

	if (decision.decision === 'reject') return;

	const db = getDb();
	const original = db.select().from(messages).where(eq(messages.id, updated.messageId)).get();
	if (!original) {
		emit({ type: 'system', body: `approval ${args.approval_id}: original message vanished` });
		return;
	}

	const targets = decision.targets;

	const settled = await Promise.allSettled(
		targets.map((targetAgentId) =>
			dispatchToAgent({
				agent_id: targetAgentId,
				channel_id: original.channelId,
				body: original.body
			})
		)
	);

	for (let i = 0; i < settled.length; i++) {
		const targetAgentId = targets[i]!;
		const r = settled[i]!;
		if (r.status === 'rejected') {
			emit({
				type: 'system',
				body: `relay to ${targetAgentId} failed: ${(r.reason as Error).message}`
			});
			continue;
		}
		const reply = r.value;
		const agentRow = recordAgentMessage({
			channelId: original.channelId,
			body: reply.body,
			agentId: reply.agentId
		});
		emit(messageBroadcast(agentRow, reply.agentId));

		const mentioned = resolveMentionedAgents(original.channelId, reply.body).filter(
			(id) => id !== reply.agentId
		);
		if (mentioned.length > 0) {
			const newApproval = createPendingApproval({
				messageId: agentRow.id,
				defaultTargets: mentioned
			});
			emit({
				type: 'approval_created',
				approval: { ...newApproval, targets: targetsOf(newApproval) },
				message_id: agentRow.id
			});
		}
	}

	const routed = markRouted(args.approval_id);
	emit({
		type: 'approval_updated',
		approval: { ...routed, targets: targetsOf(routed) }
	});
}
