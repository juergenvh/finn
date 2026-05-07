/**
 * Drizzle schema for finn.
 *
 * Reference for shape: README.md §"Data model".
 * Reference for delete policies: docs/decisions/0004-message-persistence.md.
 * Reference for ID format: docs/decisions/0003-id-formats.md.
 *
 * Conventions:
 *   - All primary keys are application-generated text ids (see db/ids.ts).
 *   - All timestamps are unix-ms integers (Date.now()), stored as INTEGER.
 *     We deliberately avoid SQLite's ad-hoc datetime strings; comparison
 *     and ordering on integers is unambiguous.
 *   - `agents.config` is stored as JSON text and validated at the
 *     application layer with zod (see db/agent-config.ts).
 */

import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';

/* ------------------------------------------------------------------ agents */

export const agents = sqliteTable('agents', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	connectorType: text('connector_type').notNull(),
	/** JSON-encoded config; shape depends on connectorType. Validated
	 * by zod on read/write at the application layer. */
	config: text('config').notNull().default('{}'),
	enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
	createdAt: integer('created_at').notNull(),
	/** Soft-delete (ADR-0004). NULL means active. */
	deletedAt: integer('deleted_at')
});

/* ----------------------------------------------------------------- channels */

export const channels = sqliteTable('channels', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	description: text('description'),
	createdAt: integer('created_at').notNull(),
	/** Soft-delete (ADR-0004). NULL means active. */
	deletedAt: integer('deleted_at')
});

/* --------------------------------------------------------- channel_members */

/**
 * Many-to-many join. Hard-delete (ADR-0004): membership is a fact about
 * the present, and historical membership is implicit in `messages.sender_id`.
 */
export const channelMembers = sqliteTable(
	'channel_members',
	{
		channelId: text('channel_id')
			.notNull()
			.references(() => channels.id),
		agentId: text('agent_id')
			.notNull()
			.references(() => agents.id),
		joinedAt: integer('joined_at').notNull()
	},
	(t) => [primaryKey({ columns: [t.channelId, t.agentId] })]
);

/* ---------------------------------------------------------------- messages */

/**
 * Append-only (ADR-0004). The application has no DELETE path for this table.
 *
 * `senderType`:
 *   - 'user'   → sender_id holds an opaque user identifier
 *                (currently always 'jurgen', single-user MVP)
 *   - 'agent'  → sender_id is an agents.id
 *   - 'system' → sender_id is null; system events (channel created etc.)
 */
export const messages = sqliteTable('messages', {
	id: text('id').primaryKey(),
	channelId: text('channel_id')
		.notNull()
		.references(() => channels.id),
	senderType: text('sender_type', { enum: ['user', 'agent', 'system'] }).notNull(),
	senderId: text('sender_id'),
	body: text('body').notNull(),
	createdAt: integer('created_at').notNull(),
	parentMessageId: text('parent_message_id')
});

/* --------------------------------------------------------------- approvals */

/**
 * Append-only (ADR-0004). Once a row exists, its history is immutable;
 * the `status` column transitions forward (pending → approved → routed
 * or pending → rejected) but the row is never deleted.
 *
 * `targetedAgentIds` is a JSON-encoded string array; per-row count is
 * small and querying-by-target across rows would use a separate index
 * table (not yet needed).
 */
export const approvals = sqliteTable('approvals', {
	id: text('id').primaryKey(),
	messageId: text('message_id')
		.notNull()
		.references(() => messages.id),
	/** Per ADR-0005, terminal-success status is `routed` (the message
	 * has been delivered to all targets). `approved` is the transient
	 * state between user decision and outbound completion. */
	status: text('status', { enum: ['pending', 'approved', 'rejected', 'routed'] })
		.notNull()
		.default('pending'),
	targetedAgentIds: text('targeted_agent_ids').notNull().default('[]'),
	rejectReason: text('reject_reason'),
	createdAt: integer('created_at').notNull(),
	decidedAt: integer('decided_at')
});

/* ------------------------------------------------------------------ types */

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
export type Channel = typeof channels.$inferSelect;
export type NewChannel = typeof channels.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type Approval = typeof approvals.$inferSelect;
export type NewApproval = typeof approvals.$inferInsert;
