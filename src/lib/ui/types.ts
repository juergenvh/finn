/**
 * UI-side type mirrors. These match the wire types in
 * src/lib/server/ws/attach.ts but live separately so the client
 * code does not import server modules.
 */

export type ChannelInfo = { id: string; name: string; description: string | null };

export type AgentInfo = {
	id: string;
	name: string;
	connectorType: string;
	enabled: boolean;
	/**
	 * The agent's `model` field, when available. Currently only set
	 * for the `openclaw` connector (where it drives session-key
	 * derivation, ADR-0012). Absent for other connectors and
	 * for rows whose stored config did not parse.
	 */
	model?: string;
	/**
	 * The agent's optional `session_override` field, when set
	 * (ADR-0017). Only meaningful for the `openclaw` connector.
	 * When present, the bubble header renders a session badge.
	 */
	sessionOverride?: string;
};

export type DBMessage = {
	id: string;
	channelId: string;
	senderType: 'user' | 'agent' | 'system';
	senderId: string | null;
	body: string;
	createdAt: number;
	hiddenAt?: number | null;
	hiddenBy?: string | null;
	/**
	 * Token-usage counters for agent replies (issue #43 part B),
	 * JSON-encoded as `{"input":N,"output":N,"total":N}` server-side.
	 * NULL for user / system / pre-feature rows / backends without
	 * usage. The page component decodes once on load and stuffs the
	 * parsed object into its in-memory `UIMessage`.
	 */
	tokensJson?: string | null;
};

export type TokenUsage = {
	input: number;
	output: number;
	total: number;
};

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'routed';

export type ApprovalSnapshot = {
	id: string;
	messageId: string;
	status: ApprovalStatus;
	targets: string[];
	rejectReason: string | null;
	createdAt: number;
	decidedAt: number | null;
};

export type WSStateChanged = {
	type: 'state_changed';
	entity: 'channel' | 'agent' | 'channel_member' | 'message';
	action: 'created' | 'updated' | 'deleted';
	id: string;
	extra?: Record<string, string | number | boolean | null>;
};

/* --- streaming agent-message lifecycle (ADR-0013) ---
 *
 * Mirrors the wire shapes from `lib/server/ws/attach.ts`. Each agent
 * reply emits one `message_start`, zero or more `message_delta`s, and
 * either one `message_end` (clean) or one `message_error` (failure).
 * During phase 2a of the rollout the server *additionally* emits a
 * legacy `message` event on completion; the client does not yet rely
 * on the streaming events, so existing handling keeps working.
 */
export type WSMessageStart = {
	type: 'message_start';
	id: string;
	channel_id: string;
	sender_id: string;
	ts: number;
};
export type WSMessageDelta = {
	type: 'message_delta';
	id: string;
	delta: string;
};
export type WSMessageEnd = {
	type: 'message_end';
	id: string;
	body: string;
	/** See server BroadcastMessageEnd; absent when the upstream
	 * backend did not surface usage on its SSE wire. */
	tokens?: TokenUsage;
};
export type WSMessageError = {
	type: 'message_error';
	id: string;
	error: string;
};

export type WSInbound =
	| {
			type: 'message';
			channel_id: string;
			sender: 'user' | 'agent' | 'system';
			sender_id: string | null;
			body: string;
			ts: number;
			id: string;
	  }
	| WSMessageStart
	| WSMessageDelta
	| WSMessageEnd
	| WSMessageError
	| { type: 'approval_created'; approval: ApprovalSnapshot; message_id: string }
	| { type: 'approval_updated'; approval: ApprovalSnapshot }
	| WSStateChanged
	| { type: 'system'; body: string }
	| { type: 'pong' };
