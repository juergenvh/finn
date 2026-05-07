/**
 * Message persistence — single place that writes to the messages table.
 *
 * Append-only per ADR-0004. There is intentionally no `deleteMessage`
 * function and no soft-delete column on this table.
 */

import { eq, asc } from 'drizzle-orm';
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

/** Fetch the recent message history for a channel, oldest first. */
export function recentMessages(channelId: string, limit = 200): Message[] {
	const db = getDb();
	return db
		.select()
		.from(messages)
		.where(eq(messages.channelId, channelId))
		.orderBy(asc(messages.createdAt))
		.limit(limit)
		.all();
}
