/**
 * Protocol viewer — cross-channel audit reads (issue #14).
 *
 * The channel view (issue #2 / #13 / #15) is the conversation
 * surface and applies user-controlled filters. The protocol viewer
 * is the audit surface: it ignores grooming visibility (per ADR-0004
 * the audit log shows everything regardless), and it spans channels
 * rather than scoping to one.
 *
 * Pagination is cursor-based on `(created_at, id)`. The cursor format
 * encodes both so duplicates at the same millisecond do not skip or
 * dupe rows. The cursor is opaque to clients; they pass it back as-is
 * via the `cursor` query parameter.
 *
 * No write paths in this module. ADR-0004 holds.
 */

import { and, asc, desc, eq, gte, lte, like, lt, gt, or, isNull, isNotNull, inArray } from 'drizzle-orm';
import { getDb } from './db/client.ts';
import { messages, channels, agents, approvals, type Message } from './db/schema.ts';

export type VisibilityFilter = 'visible_only' | 'hidden_only' | 'all';

export type ProtocolQuery = {
	/** If set, only these channels. Empty array or undefined = all. */
	channelIds?: string[];
	/** Substring search on body (LIKE). Empty/undefined = no search. */
	q?: string;
	/** Sender filter: include only these sender_types. Empty = all types. */
	senderTypes?: Array<'user' | 'agent' | 'system'>;
	/** Sender filter: include only these agent ids when sender_type='agent'. */
	senderAgentIds?: string[];
	/** Inclusive lower bound on created_at (ms). */
	from?: number;
	/** Inclusive upper bound on created_at (ms). */
	to?: number;
	/** Visibility scope (default 'all' for the protocol viewer). */
	visibility?: VisibilityFilter;
	/** Show only messages whose approval row is rejected. */
	onlyRejected?: boolean;
	/** Cursor as returned in a previous response's `next_cursor`. */
	cursor?: string;
	/** Page size. Default 200, max 1000. */
	limit?: number;
};

export type ProtocolHit = Message & {
	channelName: string;
	senderName: string | null;
};

export type ProtocolPage = {
	rows: ProtocolHit[];
	nextCursor: string | null;
};

/**
 * Encode a cursor from a row. Opaque to clients.
 *   "<created_at>:<id>"
 */
function encodeCursor(row: { createdAt: number; id: string }): string {
	return `${row.createdAt}:${row.id}`;
}

function decodeCursor(c: string): { createdAt: number; id: string } | null {
	const i = c.indexOf(':');
	if (i < 0) return null;
	const ts = Number(c.slice(0, i));
	const id = c.slice(i + 1);
	if (!Number.isFinite(ts) || id.length === 0) return null;
	return { createdAt: ts, id };
}

/**
 * Run the protocol-viewer query.
 *
 * The result is ordered DESCENDING by created_at (newest-first) which
 * is the natural reading direction for an audit surface; cursor-based
 * pagination walks backwards in time.
 */
export function queryProtocol(query: ProtocolQuery): ProtocolPage {
	const db = getDb();
	const limit = Math.min(Math.max(query.limit ?? 200, 1), 1000);

	const conditions = [];

	// channel filter
	if (query.channelIds && query.channelIds.length > 0) {
		conditions.push(inArray(messages.channelId, query.channelIds));
	}

	// substring search
	if (query.q && query.q.trim().length > 0) {
		const trimmed = query.q.trim();
		const pattern = `%${trimmed.replace(/[%_]/g, '\\$&')}%`;
		conditions.push(like(messages.body, pattern));
	}

	// sender filter
	if (query.senderTypes && query.senderTypes.length > 0 && query.senderTypes.length < 3) {
		conditions.push(inArray(messages.senderType, query.senderTypes));
	}
	if (query.senderAgentIds && query.senderAgentIds.length > 0) {
		// Only meaningful when 'agent' is in the senderTypes set, but
		// we allow it regardless and let the IN narrow naturally.
		conditions.push(inArray(messages.senderId, query.senderAgentIds));
	}

	// date range
	if (query.from !== undefined) conditions.push(gte(messages.createdAt, query.from));
	if (query.to !== undefined) conditions.push(lte(messages.createdAt, query.to));

	// visibility — default 'all'
	const visibility = query.visibility ?? 'all';
	if (visibility === 'visible_only') {
		conditions.push(isNull(messages.hiddenAt));
	} else if (visibility === 'hidden_only') {
		conditions.push(isNotNull(messages.hiddenAt));
	}
	// 'all' adds no clause: protocol viewer's default.

	// cursor: rows strictly older than (cursor.createdAt, cursor.id)
	// using lexicographic ordering on (created_at DESC, id DESC).
	if (query.cursor) {
		const c = decodeCursor(query.cursor);
		if (c) {
			conditions.push(
				or(
					lt(messages.createdAt, c.createdAt),
					and(eq(messages.createdAt, c.createdAt), lt(messages.id, c.id))
				)!
			);
		}
	}

	// onlyRejected: requires a join. We do this as a sub-query existence
	// check in JS (easier than wrestling drizzle for the SQL form): pull
	// the candidate set, then filter against the approvals table.

	const whereClause =
		conditions.length === 0
			? undefined
			: conditions.length === 1
				? conditions[0]
				: and(...conditions);

	let candidateQuery = db
		.select({
			id: messages.id,
			channelId: messages.channelId,
			senderType: messages.senderType,
			senderId: messages.senderId,
			body: messages.body,
			createdAt: messages.createdAt,
			parentMessageId: messages.parentMessageId,
			hiddenAt: messages.hiddenAt,
			hiddenBy: messages.hiddenBy,
			tokensJson: messages.tokensJson,
			channelName: channels.name
		})
		.from(messages)
		.innerJoin(channels, eq(messages.channelId, channels.id))
		.orderBy(desc(messages.createdAt), desc(messages.id));

	const ordered = whereClause
		? candidateQuery.where(whereClause).limit(limit + 1).all()
		: candidateQuery.limit(limit + 1).all();

	let candidates = ordered;

	if (query.onlyRejected) {
		// Map message-id → rejected? via the approvals table.
		const ids = candidates.map((c) => c.id);
		if (ids.length > 0) {
			const apprRows = db
				.select()
				.from(approvals)
				.where(and(inArray(approvals.messageId, ids), eq(approvals.status, 'rejected')))
				.all();
			const rejected = new Set(apprRows.map((a) => a.messageId));
			candidates = candidates.filter((c) => rejected.has(c.id));
		}
	}

	// Build agent-id → name map for sender resolution. Pull all agents
	// once (the set is small) including soft-deleted, so historical
	// rows still resolve.
	const allAgents = db
		.select({ id: agents.id, name: agents.name })
		.from(agents)
		.all();
	const agentNameById = new Map(allAgents.map((a) => [a.id, a.name]));

	// Apply pagination cap and decide whether a next-cursor exists.
	const overran = candidates.length > limit;
	const page = candidates.slice(0, limit);
	const last = page[page.length - 1];
	const nextCursor = overran && last ? encodeCursor(last) : null;

	const rows: ProtocolHit[] = page.map((row) => ({
		id: row.id,
		channelId: row.channelId,
		senderType: row.senderType,
		senderId: row.senderId,
		body: row.body,
		createdAt: row.createdAt,
		parentMessageId: row.parentMessageId,
		hiddenAt: row.hiddenAt,
		hiddenBy: row.hiddenBy,
		tokensJson: row.tokensJson,
		channelName: row.channelName,
		senderName:
			row.senderType === 'agent' && row.senderId
				? agentNameById.get(row.senderId) ?? row.senderId
				: row.senderType === 'user'
					? row.senderId
					: null
	}));

	return { rows, nextCursor };
}
