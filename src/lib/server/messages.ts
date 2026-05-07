/**
 * Message persistence — single place that writes to the messages table.
 *
 * Append-only per ADR-0004. There is intentionally no `deleteMessage`
 * function and no soft-delete column on this table.
 */

import { eq, asc, desc, and, lt, like, isNull } from 'drizzle-orm';
import { getDb } from './db/client.ts';
import { messages, type Message } from './db/schema.ts';
import { newId } from './db/ids.ts';

export type RecordUserMessage = {
	channelId: string;
	body: string;
	/** Opaque user identifier. Single-user MVP today; always 'jurgen'. */
	userId?: string;
};

export type RecordAgentMessage = {
	channelId: string;
	body: string;
	agentId: string;
};

export type RecordSystemMessage = {
	channelId: string;
	body: string;
};

export function recordUserMessage(args: RecordUserMessage): Message {
	const db = getDb();
	const row = {
		id: newId('message'),
		channelId: args.channelId,
		senderType: 'user' as const,
		senderId: args.userId ?? 'jurgen',
		body: args.body,
		createdAt: Date.now(),
		parentMessageId: null,
		hiddenAt: null,
		hiddenBy: null
	};
	db.insert(messages).values(row).run();
	return row;
}

export function recordAgentMessage(args: RecordAgentMessage): Message {
	const db = getDb();
	const row = {
		id: newId('message'),
		channelId: args.channelId,
		senderType: 'agent' as const,
		senderId: args.agentId,
		body: args.body,
		createdAt: Date.now(),
		parentMessageId: null,
		hiddenAt: null,
		hiddenBy: null
	};
	db.insert(messages).values(row).run();
	return row;
}

export function recordSystemMessage(args: RecordSystemMessage): Message {
	const db = getDb();
	const row = {
		id: newId('message'),
		channelId: args.channelId,
		senderType: 'system' as const,
		senderId: null,
		body: args.body,
		createdAt: Date.now(),
		parentMessageId: null,
		hiddenAt: null,
		hiddenBy: null
	};
	db.insert(messages).values(row).run();
	return row;
}

/**
 * Visibility scopes for message reads.
 *
 *   'channel'  — the live channel-view; filters out groomed
 *                (hidden_at IS NOT NULL) messages.
 *   'all'      — the protocol-viewer / export path; returns
 *                everything regardless of grooming. ADR-0004
 *                addendum: the audit log ignores visibility.
 */
export type Scope = 'channel' | 'all';

function visibilityClause(scope: Scope) {
	return scope === 'channel' ? isNull(messages.hiddenAt) : undefined;
}

/**
 * Fetch the recent message history for a channel, oldest first.
 *
 * Without `before`: returns the most recent `limit` messages
 * (intended for the initial UI load — the user lands at "now").
 *
 * With `before` (a millisecond timestamp): returns the `limit`
 * messages strictly older than `before`, again oldest-first. Used
 * for "load older" pagination at the scroll-top.
 *
 * In both cases the slice itself is sorted ascending so the UI can
 * just append (or prepend) without reversing.
 *
 * `scope` defaults to 'channel' (groomed messages excluded).
 * Callers reading the audit log should pass 'all'.
 */
export function recentMessages(
	channelId: string,
	limit = 200,
	before?: number,
	scope: Scope = 'channel'
): Message[] {
	const db = getDb();

	const conditions = [eq(messages.channelId, channelId)];
	if (before) conditions.push(lt(messages.createdAt, before));
	const vis = visibilityClause(scope);
	if (vis) conditions.push(vis);
	const whereClause =
		conditions.length === 1 ? conditions[0]! : and(...conditions);

	// Pull the *most recent* `limit` rows that satisfy the filter, then
	// reverse to ascending order in JS. (drizzle-sqlite has no
	// straightforward 'last N ordered ascending' single-statement form.)
	const rows = db
		.select()
		.from(messages)
		.where(whereClause)
		.orderBy(desc(messages.createdAt))
		.limit(limit)
		.all();
	rows.reverse();
	return rows;
}

/**
 * Substring search inside a single channel.
 *
 * v1: plain SQLite LIKE, case-insensitive (SQLite LIKE is case-
 * insensitive for ASCII by default; non-ASCII users may want FTS5
 * later — tracked as part of issue #2 follow-ups).
 *
 * Returns hits ascending by createdAt, capped by `limit`. The query
 * is automatically wrapped in `%...%`; callers pass the bare term.
 *
 * `scope` defaults to 'channel' (groomed messages excluded). Use
 * 'all' for the protocol-viewer surface.
 */
export function searchMessages(
	channelId: string,
	query: string,
	limit = 100,
	scope: Scope = 'channel'
): Message[] {
	const trimmed = query.trim();
	if (trimmed.length === 0) return [];
	const db = getDb();
	const pattern = `%${trimmed.replace(/[%_]/g, '\\$&')}%`;

	const conditions = [eq(messages.channelId, channelId), like(messages.body, pattern)];
	const vis = visibilityClause(scope);
	if (vis) conditions.push(vis);

	return db
		.select()
		.from(messages)
		.where(and(...conditions))
		.orderBy(asc(messages.createdAt))
		.limit(limit)
		.all();
}

/**
 * Apply a grooming decision to a message.
 *
 * Setting `hidden=true` records the current timestamp in
 * `hidden_at`; setting `hidden=false` clears both `hidden_at`
 * and `hidden_by`. Idempotent on both sides.
 *
 * Per ADR-0004 addendum: this is the one allowed mutation on the
 * messages table. body and other content columns remain
 * immutable.
 */
export function setMessageVisibility(
	messageId: string,
	hidden: boolean,
	actor = 'jurgen'
): Message | null {
	const db = getDb();
	const current = db.select().from(messages).where(eq(messages.id, messageId)).get();
	if (!current) return null;

	const now = Date.now();
	db.update(messages)
		.set({
			hiddenAt: hidden ? now : null,
			hiddenBy: hidden ? actor : null
		})
		.where(eq(messages.id, messageId))
		.run();

	return {
		...current,
		hiddenAt: hidden ? now : null,
		hiddenBy: hidden ? actor : null
	};
}
