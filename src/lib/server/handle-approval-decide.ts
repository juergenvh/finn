/**
 * Handle a user's approval/reject decision.
 *
 * Streams broadcasts via `emit`:
 *   1. Update the approval row → emit `approval_updated`.
 *   2. (Approve only) For each target in parallel: stream-relay the
 *      original message via `streamToAgent` (each target emits its
 *      own `message_start` / `message_delta` / `message_end`
 *      lifecycle, ADR-0013 phase 3). Persist completed replies on
 *      `message_end`; emit a derivative `approval_created` if a
 *      reply mentions another agent.
 *   3. Mark the approval `routed` once all target streams have
 *      terminated (cleanly or with error) → emit
 *      `approval_updated`.
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
	createRoutedApproval,
	targetsOf,
	type ApprovalDecision
} from './approvals.ts';
import { recordAgentMessage } from './messages.ts';
import { streamToAgent } from './connectors/registry.ts';
import { resolveMentionedAgents } from './mentions.ts';
import { tryConsumeRoundtrip } from './loop-defence.ts';
import { readAutoApprove } from './channel-settings.ts';
import type { Emit } from './ws/attach.ts';

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

	// Stream-relay to every target in parallel. Each target's
	// `streamToAgent` invocation emits its own
	// `message_start`/`message_delta`/`message_end` (or
	// `message_error`) directly via `emit`, so the user sees per-
	// target bubbles begin filling immediately instead of waiting
	// for the slowest relay. Promise.all resolves only when every
	// target has terminated, mirroring the previous Promise.allSettled
	// gate so `routed` still lands once the whole batch is done.
	//
	// `streamToAgent` already converts mid-stream errors into the
	// `{ error }` outcome shape; it does not throw, so a single
	// failing relay does not abort the others. The outer try/catch
	// only guards against synchronous errors before the stream
	// kicks off (e.g. an unknown agent id slipping through).
	// Roundtrip-cap gate (ADR-0020). Each target counts as one
	// agent-to-agent hop. We consume one slot per target up front;
	// on cap-hit the remaining targets are dropped and a single
	// system message tells the user. The pre-consumption shape is
	// deliberate: we'd rather have a deterministic "these N targets
	// dispatched, the rest were capped" outcome than have the cap
	// trip mid-stream where some targets already raced through.
	const dispatchTargets: string[] = [];
	let capHit: { used: number; cap: number } | null = null;
	for (const t of targets) {
		const gate = tryConsumeRoundtrip(original.channelId);
		if (!gate.allowed) {
			capHit = { used: gate.used, cap: gate.cap };
			break;
		}
		dispatchTargets.push(t);
	}
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

	// Per-target task: stream the relay, then — *as soon as that
	// individual stream completes* — persist the row and create the
	// nested approval (or recurse). Doing the post-processing
	// inside the per-target promise means the next approval button
	// pops up the moment its agent finishes, not when the slowest
	// sibling does (issue #81).
	await Promise.all(
		dispatchTargets.map(async (targetAgentId) => {
			let outcome:
				| Awaited<ReturnType<typeof streamToAgent>>
				| { agentId: string; messageId: string; error: string };
			try {
				outcome = await streamToAgent(
					{
						agent_id: targetAgentId,
						channel_id: original.channelId,
						body: original.body
					},
					emit
				);
			} catch (err) {
				outcome = {
					agentId: targetAgentId,
					messageId: '',
					error: (err as Error).message ?? String(err)
				};
			}

			if ('error' in outcome) {
				// `streamToAgent` already emitted `message_error` for
				// the per-agent path (when it got far enough to mint a
				// message id). The empty-messageId pre-stream failure
				// case is rarer; surface it once via system event so
				// the user is not left wondering why a target produced
				// no bubble at all.
				if (outcome.messageId === '') {
					emit({
						type: 'system',
						body: `relay to ${outcome.agentId} failed: ${outcome.error}`
					});
				}
				return;
			}

			const agentRow = recordAgentMessage({
				id: outcome.messageId,
				channelId: original.channelId,
				body: outcome.body,
				agentId: outcome.agentId,
				tokens: outcome.tokens
			});

			// A relayed reply may itself mention yet another agent
			// and create a fresh approval (ADR-0005 recursion). The
			// new approval honours the channel's current
			// auto-approve flag: if the user hand-approved their
			// way into this branch but the channel is auto-
			// approve-on, nested hops route directly (consistent
			// with how a fresh user message would behave in the
			// same channel).
			const mentioned = resolveMentionedAgents(
				original.channelId,
				outcome.body
			).filter((id) => id !== outcome.agentId);
			if (mentioned.length === 0) return;

			if (readAutoApprove(original.channelId)) {
				await dispatchAutoApproveNested({
					channelId: original.channelId,
					messageId: agentRow.id,
					body: outcome.body,
					targets: mentioned,
					emit
				});
			} else {
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
		})
	);

	const routed = markRouted(args.approval_id);
	emit({
		type: 'approval_updated',
		approval: { ...routed, targets: targetsOf(routed) }
	});
}

/**
 * Auto-approve dispatch for a nested mention reached *from inside*
 * the approval-decide path. Same shape as handle-user-message's
 * `dispatchAutoApprove`, kept local to keep the two flows readable
 * side-by-side rather than smearing into a single 5-parameter
 * helper. Consolidate only if a third caller appears.
 */
async function dispatchAutoApproveNested(args: {
	channelId: string;
	messageId: string;
	body: string;
	targets: string[];
	emit: Emit;
}): Promise<void> {
	const { channelId, messageId, body, targets, emit } = args;

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

	const nestedApproval = createRoutedApproval({
		messageId,
		targets: dispatchTargets,
		createdVia: 'auto_approve'
	});
	emit({
		type: 'approval_created',
		approval: { ...nestedApproval, targets: targetsOf(nestedApproval) },
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

	// Inline per-target post-processing — see issue #81. A slow
	// nested relay must not delay the audit/dispatch events for the
	// fast sibling next to it.
	await Promise.all(
		dispatchTargets.map(async (targetAgentId) => {
			let outcome:
				| Awaited<ReturnType<typeof streamToAgent>>
				| { agentId: string; messageId: string; error: string };
			try {
				outcome = await streamToAgent(
					{ agent_id: targetAgentId, channel_id: channelId, body },
					emit
				);
			} catch (err) {
				outcome = {
					agentId: targetAgentId,
					messageId: '',
					error: (err as Error).message ?? String(err)
				};
			}

			if ('error' in outcome) {
				if (outcome.messageId === '') {
					emit({
						type: 'system',
						body: `relay to ${outcome.agentId} failed: ${outcome.error}`
					});
				}
				return;
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
			if (nestedMentioned.length === 0) return;

			await dispatchAutoApproveNested({
				channelId,
				messageId: nestedRow.id,
				body: outcome.body,
				targets: nestedMentioned,
				emit
			});
		})
	);
}
