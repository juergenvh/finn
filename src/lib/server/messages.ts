/**
 * Message persistence — single place that writes to the messages table.
 *
 * Append-only per ADR-0004. There is intentionally no `deleteMessage`
 * function and no soft-delete column on this table.
 */

import { eq, asc, desc, and, lt, like, or } from 'drizzle-orm';
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
		parentMessageId: null
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
		parentMessageId: null
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
		parentMessageId: null
	};
	db.insert(messages).values(row).run();
	return row;
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
 */
export function recentMessages(
	channelId: string,
	limit = 200,
	before?: number
): Message[] {
	const db = getDb();

	const whereClause = before
		? and(eq(messages.channelId, channelId), lt(messages.createdAt, before))
		: eq(messages.channelId, channelId);

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
 */
export function searchMessages(
	channelId: string,
	query: string,
	limit = 100
): Message[] {
	const trimmed = query.trim();
	if (trimmed.length === 0) return [];
	const db = getDb();
	const pattern = `%${trimmed.replace(/[%_]/g, '\\$&')}%`;
	return db
		.select()
		.from(messages)
		.where(and(eq(messages.channelId, channelId), like(messages.body, pattern)))
		.orderBy(asc(messages.createdAt))
		.limit(limit)
		.all();
}
