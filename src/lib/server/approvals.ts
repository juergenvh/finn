/**
 * Approval state machine and persistence.
 *
 * State transitions (per ADR-0005):
 *   pending → approved → routed   (success path)
 *   pending → rejected             (terminal failure)
 *
 * `approved` is transient: the row briefly sits there while we fan
 * out the outbound calls, then transitions to `routed`. If the
 * server dies in this window, startup-recovery will need to either
 * retry or move the row to a failure state. (Recovery is not yet
 * implemented; we will add it before we ship beyond a single user.)
 *
 * The approvals table is append-only at row level (ADR-0004) — we
 * never DELETE here; only `status`, `targetedAgentIds`, `decidedAt`,
 * and `rejectReason` change.
 */

import { eq } from 'drizzle-orm';
import { getDb } from './db/client.ts';
import { approvals, type Approval, type Message } from './db/schema.ts';
import { newId } from './db/ids.ts';

export type ApprovalDecision =
	| { decision: 'approve'; targets: string[] }
	| { decision: 'reject'; reason?: string };

/**
 * Create a `pending` approval row for an agent message.
 * `defaultTargets` are the mention-resolved targets — they are the
 * UI's pre-fill, but the user can change them before deciding.
 *
 * `createdVia` defaults to `'mention'` because that is the only
 * route that produces a *pending* row today: an agent reply
 * mentions another agent and the user has to decide. Forward
 * (`'forward'`) and auto-approve (`'auto_approve'`) skip pending
 * entirely and use `createRoutedApproval`.
 */
export function createPendingApproval(args: {
	messageId: string;
	defaultTargets: string[];
	createdVia?: 'mention';
}): Approval {
	const db = getDb();
	const row = {
		id: newId('approval'),
		messageId: args.messageId,
		status: 'pending' as const,
		targetedAgentIds: JSON.stringify(args.defaultTargets),
		rejectReason: null,
		createdAt: Date.now(),
		decidedAt: null,
		createdVia: args.createdVia ?? 'mention'
	};
	db.insert(approvals).values(row).run();
	return row;
}

/**
 * Apply a user decision. Returns the updated row.
 * Throws if the row is not in `pending` (no double-decisions).
 */
export function decideApproval(approvalId: string, decision: ApprovalDecision): Approval {
	const db = getDb();
	const current = db.select().from(approvals).where(eq(approvals.id, approvalId)).get();
	if (!current) throw new Error(`approval not found: ${approvalId}`);
	if (current.status !== 'pending') {
		throw new Error(`approval ${approvalId} already decided (${current.status})`);
	}

	const now = Date.now();
	if (decision.decision === 'approve') {
		const updated = {
			...current,
			status: 'approved' as const,
			targetedAgentIds: JSON.stringify(decision.targets),
			decidedAt: now
		};
		db.update(approvals)
			.set({
				status: updated.status,
				targetedAgentIds: updated.targetedAgentIds,
				decidedAt: updated.decidedAt
			})
			.where(eq(approvals.id, approvalId))
			.run();
		return updated;
	} else {
		const updated = {
			...current,
			status: 'rejected' as const,
			rejectReason: decision.reason ?? null,
			decidedAt: now
		};
		db.update(approvals)
			.set({
				status: updated.status,
				rejectReason: updated.rejectReason,
				decidedAt: updated.decidedAt
			})
			.where(eq(approvals.id, approvalId))
			.run();
		return updated;
	}
}

/**
 * Create an approval row that bypasses the pending→approved stages
 * and starts directly in `routed`. Used by the user-triggered
 * forward path (issue #52): the user's deliberate forward click
 * *is* the human-in-the-loop approval; a second confirmation
 * would be redundant.
 *
 * The row exists for audit/protocol-viewer continuity — forwards
 * leave the same paper trail as a regular pending→approved→routed
 * approval, and any code that reads the approvals table
 * (protocol viewer, message export) treats them uniformly.
 *
 * `decidedAt` is set to creation time so the audit answer to
 * "when was this routed?" is unambiguous.
 */
export function createRoutedApproval(args: {
	messageId: string;
	targets: string[];
	createdVia?: 'forward' | 'auto_approve';
}): Approval {
	const db = getDb();
	const now = Date.now();
	const row = {
		id: newId('approval'),
		messageId: args.messageId,
		status: 'routed' as const,
		targetedAgentIds: JSON.stringify(args.targets),
		rejectReason: null,
		createdAt: now,
		decidedAt: now,
		createdVia: args.createdVia ?? 'forward'
	};
	db.insert(approvals).values(row).run();
	return row;
}

/** Mark an approved row as fully routed (all outbound calls done). */
export function markRouted(approvalId: string): Approval {
	const db = getDb();
	const current = db.select().from(approvals).where(eq(approvals.id, approvalId)).get();
	if (!current) throw new Error(`approval not found: ${approvalId}`);
	if (current.status !== 'approved') {
		throw new Error(`approval ${approvalId} not in approved state (${current.status})`);
	}
	db.update(approvals).set({ status: 'routed' }).where(eq(approvals.id, approvalId)).run();
	return { ...current, status: 'routed' };
}

/** Read all approvals tied to a list of message ids (for UI hydration). */
export function approvalsForMessages(messageIds: string[]): Approval[] {
	if (messageIds.length === 0) return [];
	const db = getDb();
	// Drizzle's `inArray` is the right call here; we use a small
	// subquery via .all() and filter in JS for the spike to keep
	// dependencies minimal.
	return db
		.select()
		.from(approvals)
		.all()
		.filter((a) => messageIds.includes(a.messageId));
}

export function approvalById(id: string): Approval | undefined {
	const db = getDb();
	return db.select().from(approvals).where(eq(approvals.id, id)).get();
}

/** Parse the JSON-encoded targetedAgentIds column. */
export function targetsOf(approval: Approval | Pick<Approval, 'targetedAgentIds'>): string[] {
	try {
		const parsed = JSON.parse(approval.targetedAgentIds) as unknown;
		return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
	} catch {
		return [];
	}
}

export type { Approval, Message };
