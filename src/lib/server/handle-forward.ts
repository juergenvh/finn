/**
 * Handle a user-triggered forward of an existing message to one or
 * more channel-member agents (issue #52).
 *
 * The user clicked a "forward to..." action on a bubble, picked
 * targets, and confirmed. We:
 *
 *   1. Look up the source message; reject system-authored ones
 *      (no use case) and ones that no longer exist.
 *   2. Filter the requested targets to enabled channel members.
 *      Off-channel agents and disabled rows are silently dropped
 *      with a system-event diagnostic, mirroring how mention
 *      resolution behaves on the user-message path (issue #27 +
 *      streamUserMessage).
 *   3. Stream-relay the original body to each surviving target in
 *      parallel via `streamToAgent`. Each emits its own
 *      `message_start` / `message_delta` / `message_end` (or
 *      `message_error`) lifecycle, same as the approval-routing
 *      path (ADR-0013 phase 3).
 *   4. Persist completed replies on `message_end`, recurse the
 *      mention-handling so a forwarded reply that itself mentions
 *      another agent creates a fresh pending approval (matches
 *      ADR-0005 §recursion).
 *   5. Create an approval row in `routed` status (skip the
 *      pending → approved → routed transition). Forwarding's
 *      human-in-the-loop is the user's deliberate forward click
 *      itself; a second confirmation would be redundant. The row
 *      exists so the audit/protocol-viewer surface and the
 *      bubble's "routed to: ..." sub-line both show forwards
 *      uniformly with regular approvals.
 *
 * Bodies are forwarded verbatim — no `[forwarded from ...]`
 * prefix. Symmetric with the approval-relay path. The receiving
 * agent has no wire-level signal that this is a relay.
 */

import { eq } from 'drizzle-orm';
import { getDb } from './db/client.ts';
import { agents, channelMembers, messages } from './db/schema.ts';
import { recordAgentMessage } from './messages.ts';
import { streamToAgent } from './connectors/registry.ts';
import { resolveMentionedAgents } from './mentions.ts';
import {
	createPendingApproval,
	createRoutedApproval,
	targetsOf
} from './approvals.ts';
import { and, isNull } from 'drizzle-orm';
import type { Emit } from './ws/attach.ts';

export type ForwardArgs = {
	message_id: string;
	target_agent_ids: string[];
};

/**
 * Resolve a target id list to the subset of agents that are
 * enabled members of the given channel. The dropped tail is
 * returned alongside so the caller can surface a diagnostic
 * for ids the UI accepted but the server can't honour
 * (off-channel, disabled, deleted).
 */
function filterToChannelMembers(
	channelId: string,
	requested: string[]
): { allowed: string[]; dropped: string[] } {
	if (requested.length === 0) return { allowed: [], dropped: [] };

	const db = getDb();
	const memberIds = new Set(
		db
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
			.all()
			.map((r) => r.id)
	);

	const allowed: string[] = [];
	const dropped: string[] = [];
	const seen = new Set<string>();
	for (const id of requested) {
		if (seen.has(id)) continue;
		seen.add(id);
		if (memberIds.has(id)) allowed.push(id);
		else dropped.push(id);
	}
	return { allowed, dropped };
}

export async function handleForwardMessage(args: ForwardArgs, emit: Emit): Promise<void> {
	const db = getDb();
	const original = db
		.select()
		.from(messages)
		.where(eq(messages.id, args.message_id))
		.get();

	if (!original) {
		emit({ type: 'system', body: `forward: message ${args.message_id} not found` });
		return;
	}
	if (original.senderType === 'system') {
		emit({ type: 'system', body: 'forward: system messages cannot be forwarded' });
		return;
	}

	const { allowed, dropped } = filterToChannelMembers(
		original.channelId,
		args.target_agent_ids
	);

	if (dropped.length > 0) {
		emit({
			type: 'system',
			body: `forward: ${dropped.length} target(s) dropped (not channel members or disabled)`
		});
	}

	if (allowed.length === 0) {
		emit({ type: 'system', body: 'forward: no valid targets, nothing dispatched' });
		return;
	}

	// Stream-relay each target in parallel. Same shape as the
	// approval-routing path; streamToAgent handles per-agent
	// message_* lifecycle and converts mid-flight errors into the
	// { error } outcome shape (so a single failing relay does not
	// abort the others).
	const outcomes = await Promise.all(
		allowed.map(async (targetAgentId) => {
			try {
				return await streamToAgent(
					{
						agent_id: targetAgentId,
						channel_id: original.channelId,
						body: original.body
					},
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

	for (const outcome of outcomes) {
		if ('error' in outcome) {
			if (outcome.messageId === '') {
				emit({
					type: 'system',
					body: `forward to ${outcome.agentId} failed: ${outcome.error}`
				});
			}
			// streamToAgent already emitted message_error for the
			// post-stream-start failure case.
			continue;
		}

		const agentRow = recordAgentMessage({
			id: outcome.messageId,
			channelId: original.channelId,
			body: outcome.body,
			agentId: outcome.agentId,
			tokens: outcome.tokens
		});

		// A forwarded reply that mentions another agent triggers a
		// regular pending approval — the recursion gate stays the
		// same; only the *first* hop of a forward skips it.
		const mentioned = resolveMentionedAgents(original.channelId, outcome.body).filter(
			(id) => id !== outcome.agentId
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

	// Audit row: pinned to the *original* message id, with the
	// allowed-target list. The bubble it attaches to (the source
	// message) renders the "routed to: ..." sub-line via the
	// existing approval-display logic — visually a forwarded
	// bubble looks exactly like an approved-and-routed mention.
	const routed = createRoutedApproval({
		messageId: original.id,
		targets: allowed
	});
	emit({
		type: 'approval_created',
		approval: { ...routed, targets: targetsOf(routed) },
		message_id: original.id
	});
}
