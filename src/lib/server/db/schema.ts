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
	parentMessageId: text('parent_message_id'),
	/**
	 * Channel-grooming visibility flag (issue #15, ADR-0004 addendum).
	 * NULL    = visible in the channel view.
	 * <ms-ts> = hidden by the user at this timestamp.
	 *
	 * The protocol viewer and markdown exports ignore this flag and
	 * show the row regardless. Setting/clearing this column is the
	 * one allowed mutation on the messages table; body and the
	 * other content columns remain immutable.
	 */
	hiddenAt: integer('hidden_at'),
	/**
	 * Identifier of who hid the message. NULL when not hidden.
	 * Today always 'jurgen' for finn's single-user MVP; left as a
	 * column rather than a constant so a future per-user model
	 * doesn't need a schema reshape.
	 */
	hiddenBy: text('hidden_by'),
	/**
	 * Token-usage counters for agent replies, JSON-encoded
	 * `{ input: number; output: number; total: number }` (issue #43
	 * part B). NULL for:
	 *   - user / system messages (no LLM call to count against)
	 *   - agent backends that do not surface usage today
	 *     (Wintermute's `/v1/*` adapter at the moment;
	 *     `anthropic-stub`)
	 *   - historical rows written before this column existed
	 *
	 * Set once at insert time on the streaming `message_end` path
	 * (see ADR-0013 + handle-user-message.ts /
	 * handle-approval-decide.ts). Append-only contract intact: the
	 * column is never updated.
	 */
	tokensJson: text('tokens_json')
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

/* ------------------------------------------------------------------ settings */

/**
 * Global runtime settings (ADR-0019).
 *
 * Singleton table — exactly one row, identified by `id = 1`. The
 * application layer upserts on that id; there is never more than one
 * row. Migrations add columns for each new global setting; cost of
 * one migration per setting is accepted in exchange for typed
 * columns, validation-for-free, and a self-documenting schema.
 *
 * Defaults here are the *hardcoded* defaults — the same constants
 * the code falls back to if the row is missing entirely. The seed
 * migration writes the row at id=1 with these values; subsequent
 * changes are UPDATEs.
 */
export const settingsGlobal = sqliteTable('settings_global', {
	id: integer('id').primaryKey(),
	/** Initial-load KB budget for the channel view (ADR-0011, issue #13). */
	kbBudgetDefault: integer('kb_budget_default').notNull().default(200),
	/** Default value for the channel view's `Show groomed` toggle (issue #15). */
	showGroomedDefault: integer('show_groomed_default', { mode: 'boolean' }).notNull().default(false),
	/** Default value for the channel view's `Hide system messages` toggle. */
	hideSystemMessagesDefault: integer('hide_system_messages_default', { mode: 'boolean' })
		.notNull()
		.default(false),
	/** Channel id to open by default when the user lands on `/`.
	 * NULL → fall back to last-active (current behaviour). */
	defaultChannelId: text('default_channel_id'),
	/** Theme preference, persisted in DB so it survives device swaps. */
	theme: text('theme', { enum: ['system', 'light', 'dark'] })
		.notNull()
		.default('system'),
	/** Default agent-to-agent roundtrip cap per user-message window
	 * (ADR-0020). Resets on every persisted user message in the
	 * channel. Bounded [1..100] at the API layer. */
	roundtripCapDefault: integer('roundtrip_cap_default').notNull().default(5),
	updatedAt: integer('updated_at').notNull()
});

/**
 * Per-channel setting overrides (ADR-0019).
 *
 * One row per channel that has at least one override; channels
 * without a row inherit global on every key. `ON DELETE CASCADE`
 * keeps the table tidy when a channel is hard-deleted (future
 * channel-name-reuse work, issue #25).
 *
 * Precedence: channel override → global → compiled constant.
 */
export const settingsChannel = sqliteTable('settings_channel', {
	channelId: text('channel_id')
		.primaryKey()
		.references(() => channels.id, { onDelete: 'cascade' }),
	/** Channel-specific override for the initial-load KB budget.
	 * NULL → inherit `settings_global.kb_budget_default`. */
	kbBudgetOverride: integer('kb_budget_override'),
	/** Per-channel auto-approve toggle for agent-to-agent mentions
	 * (ADR-0015, issue #28). Default false; the UI surface that
	 * flips it lands in the ADR-0015 PR stack on top of this column. */
	autoApprove: integer('auto_approve', { mode: 'boolean' }).notNull().default(false),
	/** Channel-specific override for the roundtrip cap (ADR-0020).
	 * NULL → inherit `settings_global.roundtrip_cap_default`. */
	roundtripCapOverride: integer('roundtrip_cap_override'),
	updatedAt: integer('updated_at').notNull()
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
export type SettingsGlobal = typeof settingsGlobal.$inferSelect;
export type NewSettingsGlobal = typeof settingsGlobal.$inferInsert;
export type SettingsChannel = typeof settingsChannel.$inferSelect;
export type NewSettingsChannel = typeof settingsChannel.$inferInsert;
