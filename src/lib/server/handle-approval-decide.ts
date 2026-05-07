/**
 * Handle a user's approval/reject decision.
 *
 * Approve path:
 *   1. Update the approval row to `approved` with the chosen targets.
 *   2. For each target: dispatch the original message to that agent
 *      via the connector, persist the resulting reply, parse mentions
 *      in that reply, and (if needed) create a *new* pending approval.
 *   3. Mark the original approval `routed` once all targets have been
 *      delivered.
 *   4. Broadcast every state change.
 *
 * Reject path: update to `rejected`, broadcast, done. No outbound calls.
 *
 * The reply chain is intentional: an approval can spawn further
 * approvals (Agent_A → Agent_B; Agent_B's reply mentions Agent_C).
 * The recursion is bounded by the channel-member set size; each round
 * is paused for human approval, so an actual loop is impossible.
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
import type {
	UserMessageResult,
	BroadcastMessage,
	BroadcastApprovalCreated,
	BroadcastApprovalUpdated
} from './ws/attach.ts';

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

export async function handleApprovalDecide(args: ApprovalDecideArgs): Promise<UserMessageResult> {
	const decision: ApprovalDecision =
		args.decision === 'approve'
			? { decision: 'approve', targets: args.targets ?? [] }
			: { decision: 'reject', reason: args.reject_reason };

	// 1. Update the row.
	const updated = decideApproval(args.approval_id, decision);
	const result: UserMessageResult = { broadcasts: [] };

	const updatedEvt: BroadcastApprovalUpdated = {
		type: 'approval_updated',
		approval: { ...updated, targets: targetsOf(updated) }
	};
	result.broadcasts.push(updatedEvt);

	// 2. Reject is terminal.
	if (decision.decision === 'reject') return result;

	// 3. Approve: fetch the original message, fan out to targets.
	const db = getDb();
	const original = db.select().from(messages).where(eq(messages.id, updated.messageId)).get();
	if (!original) {
		result.broadcasts.push({
			type: 'system',
			body: `approval ${args.approval_id}: original message vanished`
		});
		return result;
	}

	const targets = decision.targets;

	// Dispatch in parallel (each target gets the same message in parallel),
	// but record outcomes serially so DB ordering stays clean.
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
			result.broadcasts.push({
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
		result.broadcasts.push(messageBroadcast(agentRow, reply.agentId));

		// Recursive approval: did this reply mention yet another agent?
		const mentioned = resolveMentionedAgents(original.channelId, reply.body).filter(
			(id) => id !== reply.agentId
		);
		if (mentioned.length > 0) {
			const newApproval = createPendingApproval({
				messageId: agentRow.id,
				defaultTargets: mentioned
			});
			const evt: BroadcastApprovalCreated = {
				type: 'approval_created',
				approval: { ...newApproval, targets: targetsOf(newApproval) },
				message_id: agentRow.id
			};
			result.broadcasts.push(evt);
		}
	}

	// 4. Mark the original approval routed.
	const routed = markRouted(args.approval_id);
	const routedEvt: BroadcastApprovalUpdated = {
		type: 'approval_updated',
		approval: { ...routed, targets: targetsOf(routed) }
	};
	result.broadcasts.push(routedEvt);

	return result;
}
