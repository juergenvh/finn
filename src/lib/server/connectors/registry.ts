/**
 * Connector registry — DB-driven dispatch.
 *
 * Two entry points, both streaming (ADR-0013 phases 2 + 3):
 *
 *   streamUserMessage(args, emit)
 *     Fans out to enabled member agents of the channel and streams
 *     each agent's reply through `emit` as a
 *     `message_start` / `message_delta` / `message_end` lifecycle.
 *     If the body contains `@-mentions`, only the mentioned agents
 *     that resolve to channel members are dispatched (issue #27);
 *     otherwise the full member list is fanned out. User messages
 *     do not require approval (ADR-0005 §1). Returns a
 *     `StreamDispatchResult` with the diagnostics and a per-agent
 *     outcome list (final body or error message); the caller uses
 *     this to drive approval-creation on completed replies and to
 *     surface unresolved-mention warnings.
 *
 *   streamToAgent(args, emit)
 *     Streams the original agent message to one specific target
 *     agent. Used by the approval-routing path after the user
 *     clicks Approve. The body is the *original* agent message —
 *     finn does not paraphrase or annotate; it relays verbatim.
 *     Same per-agent stream lifecycle (`message_start` /
 *     `message_delta` / `message_end` or `message_error`) as
 *     `streamUserMessage`. Returns a single
 *     `StreamedDispatchedReply` on clean termination, or an
 *     `{ agentId, messageId, error }` shape on failure; the
 *     receiving agent's reply itself becomes a regular agent
 *     message in the channel and may trigger its own approval if
 *     it mentions yet another agent.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '../db/client.ts';
import { agents, channelMembers, channels } from '../db/schema.ts';
import { newId } from '../db/ids.ts';
import { parseAgentConfig } from '../db/agent-config.ts';
import { extractMentions, resolveMentionedAgents } from '../mentions.ts';
import { openclawConnector } from './openclaw.ts';
import { openAICompatibleConnector } from './openai-compatible.ts';
import { anthropicStubConnector } from './anthropic-stub.ts';
import type {
	BroadcastMessageDelta,
	BroadcastMessageEnd,
	BroadcastMessageError,
	BroadcastMessageStart
} from '../ws/attach.ts';
import type { SseEvent, UsageReport } from './sse-parser.ts';

/**
 * One completed agent reply produced by the streaming dispatcher.
 *
 * The `messageId` is the pre-generated id used across the
 * `message_start` / `message_delta` / `message_end` lifecycle, so
 * the caller can persist with `recordAgentMessage({ id: messageId,
 * ... })` and downstream clients see a row whose primary key
 * matches the streamed events.
 *
 * `tokens` carries the upstream `usage` block when the backend
 * surfaced one on its SSE wire. It is `null` for backends that do
 * not (Wintermute today; `anthropic-stub`); the dispatcher writes
 * NULL into `messages.tokens_json` in that case.
 */
export type StreamedDispatchedReply = {
	agentId: string;
	messageId: string;
	body: string;
	tokens: UsageReport | null;
};

/**
 * Diagnostic info about how the dispatch interpreted the message body.
 * The caller uses this to surface a system event when the user's
 * mentions did not resolve to any channel-member agent.
 */
export type DispatchDiagnostics = {
	/** Mention tokens parsed from the body, in order of appearance. */
	mentionTokens: string[];
	/** Mention tokens that did not resolve to a channel-member agent. */
	unresolvedMentionTokens: string[];
	/** Whether the dispatch was narrowed by mentions (true) or fanned
	 * out to all members (false). */
	narrowedByMentions: boolean;
};

/**
 * Result of `streamUserMessage`. The streaming events have already
 * been emitted by the time this returns; this object summarises
 * the per-agent outcomes so the caller can persist completed
 * replies and create approval rows for agent-to-agent mentions.
 *
 * Per-agent outcome: either `{ agentId, messageId, body }` for a
 * completed stream, or `{ agentId, messageId, error }` for one that
 * failed mid-flight.
 */
export type StreamDispatchResult = {
	replies: Array<
		| StreamedDispatchedReply
		| { agentId: string; messageId: string; error: string }
	>;
	diagnostics: DispatchDiagnostics;
};

const ECHO = (process.env.FINN_ECHO_ONLY ?? '').toLowerCase() === '1';

type MemberAgent = {
	id: string;
	name: string;
	connectorType: string;
	config: string;
};

function memberAgentsOf(channelId: string): MemberAgent[] {
	const db = getDb();
	return db
		.select({
			id: agents.id,
			name: agents.name,
			connectorType: agents.connectorType,
			config: agents.config
		})
		.from(channelMembers)
		.innerJoin(agents, eq(channelMembers.agentId, agents.id))
		.where(
			and(
				eq(channelMembers.channelId, channelId),
				isNull(agents.deletedAt),
				eq(agents.enabled, true)
			)
		)
		.all();
}

function requireChannel(channelId: string): void {
	const db = getDb();
	const channel = db
		.select()
		.from(channels)
		.where(and(eq(channels.id, channelId), isNull(channels.deletedAt)))
		.get();
	if (!channel) {
		throw new Error(`unknown or deleted channel: ${channelId}`);
	}
}

/**
 * Resolve the per-connector streaming generator for an agent.
 *
 * Yields `SseEvent`s (content deltas + the optional final usage
 * block). The dispatcher's `streamOneAgent` consumes both kinds.
 *
 * `FINN_ECHO_ONLY=1` short-circuits to a single-chunk yield of a
 * canned echo body so test/dev environments don't need real
 * backends. The dispatcher pipeline then drives the same
 * `streamOneAgent` lifecycle around the canned chunk as it would
 * around a real upstream stream. No usage event is emitted on
 * the echo path — the row is persisted with NULL tokens.
 */
function streamConnector(
	agent: MemberAgent,
	channelId: string,
	body: string
): AsyncIterable<SseEvent> {
	if (ECHO) {
		return (async function* () {
			yield { kind: 'delta', text: `echo (${agent.name}): ${body}` };
		})();
	}

	const config = parseAgentConfig(agent.connectorType, agent.config);

	if (config.connector_type === 'openclaw') {
		return openclawConnector.streamReply({ channelId, body, config });
	}
	if (config.connector_type === 'openai-compatible') {
		return openAICompatibleConnector.streamReply({ channelId, body, config });
	}
	if (config.connector_type === 'anthropic-stub') {
		return anthropicStubConnector.streamReply({ channelId, body, config });
	}
	throw new Error(`unknown connector_type for agent ${agent.id}: ${agent.connectorType}`);
}

/**
 * Resolve the recipient set for a user message (shared by streaming
 * and non-streaming dispatch paths). See `streamUserMessage` for the
 * mention-handling semantics.
 */
function resolveRecipients(
	channelId: string,
	body: string,
	members: MemberAgent[]
): {
	recipients: MemberAgent[];
	mentionTokens: string[];
	unresolvedMentionTokens: string[];
	narrowedByMentions: boolean;
} {
	const mentionTokens = extractMentions(body);
	if (mentionTokens.length === 0) {
		return {
			recipients: members,
			mentionTokens,
			unresolvedMentionTokens: [],
			narrowedByMentions: false
		};
	}

	const resolvedIds = new Set(resolveMentionedAgents(channelId, body));
	const recipients = members.filter((m) => resolvedIds.has(m.id));

	// Compute the unresolved set: tokens in the body that did not
	// match any channel-member agent (by id or by name, see
	// resolveMentionedAgents). We re-derive the matching predicate
	// here so the diagnostic stays in sync with mentions.ts'
	// resolution rules.
	const memberIds = new Set(members.map((m) => m.id));
	const memberNamesLower = new Set(members.map((m) => m.name.toLowerCase()));
	const unresolvedMentionTokens = mentionTokens.filter(
		(t) => !memberIds.has(t) && !memberNamesLower.has(t.toLowerCase())
	);

	return {
		recipients,
		mentionTokens,
		unresolvedMentionTokens,
		narrowedByMentions: true
	};
}

type StreamEmit = (
	event:
		| BroadcastMessageStart
		| BroadcastMessageDelta
		| BroadcastMessageEnd
		| BroadcastMessageError
) => void;

/**
 * Per-agent streaming pipeline — the shared core of
 * `streamUserMessage` (multi-recipient fan-out) and
 * `streamToAgent` (single-recipient relay).
 *
 * Mints a fresh message id, emits `message_start`, iterates the
 * connector's `streamReply` (one `message_delta` per content
 * chunk accumulating the body, plus the optional final
 * `usage` block), and emits exactly one of `message_end` (clean)
 * or `message_error` (mid-flight failure). Returns the per-agent
 * outcome shape for the caller to persist or surface; the
 * `tokens` field is the captured `usage` block or `null` when
 * the backend never emitted one.
 */
async function streamOneAgent(
	agent: MemberAgent,
	channelId: string,
	body: string,
	emit: StreamEmit
): Promise<StreamedDispatchedReply | { agentId: string; messageId: string; error: string }> {
	const messageId = newId('message');
	const startedAt = Date.now();
	emit({
		type: 'message_start',
		id: messageId,
		channel_id: channelId,
		sender_id: agent.id,
		ts: startedAt
	});

	let fullBody = '';
	let tokens: UsageReport | null = null;
	try {
		const stream = streamConnector(agent, channelId, body);
		for await (const event of stream) {
			if (event.kind === 'delta') {
				if (event.text.length === 0) continue;
				fullBody += event.text;
				emit({ type: 'message_delta', id: messageId, delta: event.text });
			} else if (event.kind === 'usage') {
				// At-most-once per stream by parser contract; if a
				// pathological backend ever emits it twice, last
				// wins. The amounts are the upstream's authoritative
				// counters — we do not derive or estimate.
				tokens = event.usage;
			}
		}

		if (fullBody.length === 0) {
			throw new Error('connector stream ended with no content');
		}

		emit({
			type: 'message_end',
			id: messageId,
			body: fullBody,
			tokens: tokens ?? undefined
		});
		return { agentId: agent.id, messageId, body: fullBody, tokens };
	} catch (err) {
		const error = (err as Error).message ?? String(err);
		emit({ type: 'message_error', id: messageId, error });
		return { agentId: agent.id, messageId, error };
	}
}

/**
 * Stream a user message to all recipient agents in parallel.
 *
 * For each recipient the dispatcher:
 *   1. Mints a final message id and emits `message_start`.
 *   2. Iterates the connector's `streamReply`, emitting one
 *      `message_delta` per yielded chunk and accumulating the body.
 *   3. On clean stream end, emits `message_end` with the full body.
 *      The caller is responsible for persisting the row (it has the
 *      additional context to wire approvals, see
 *      `handle-user-message.ts`). The result list carries the final
 *      body so the caller can pass it straight to
 *      `recordAgentMessage({ id: messageId, body, ... })`.
 *   4. On any error mid-flight, emits `message_error` instead of
 *      `message_end` and reports the error in the result list.
 *
 * Recipients run in parallel via `Promise.all`; one failing stream
 * does not abort the others. The returned promise resolves once
 * every per-agent path has terminated (cleanly or with error).
 *
 * Mention semantics match the previous `dispatchUserMessage`:
 * `@-mentions` narrow the recipient set; tokens that don't resolve
 * to a channel member are surfaced via
 * `diagnostics.unresolvedMentionTokens` for the caller to warn on.
 */
/**
 * Optional per-reply hook. Called inside the per-agent promise as
 * soon as that agent's stream terminates cleanly, before the outer
 * `Promise.all` resolves. The caller uses this to do per-reply
 * work (persist row, create approval) without waiting for the
 * slowest sibling — see #81. Errors thrown by the callback are
 * converted into a per-agent error outcome.
 */
export type OnReplyComplete = (reply: StreamedDispatchedReply) => Promise<void>;

export async function streamUserMessage(
	args: { channel_id: string; body: string },
	emit: StreamEmit,
	onReplyComplete?: OnReplyComplete
): Promise<StreamDispatchResult> {
	requireChannel(args.channel_id);
	const members = memberAgentsOf(args.channel_id);
	if (members.length === 0) {
		throw new Error(`channel ${args.channel_id} has no enabled agent members`);
	}

	const {
		recipients,
		mentionTokens,
		unresolvedMentionTokens,
		narrowedByMentions
	} = resolveRecipients(args.channel_id, args.body, members);

	const replies: StreamDispatchResult['replies'] = await Promise.all(
		recipients.map(async (agent) => {
			const outcome = await streamOneAgent(agent, args.channel_id, args.body, emit);
			if (onReplyComplete && !('error' in outcome)) {
				try {
					await onReplyComplete(outcome);
				} catch (err) {
					return {
						agentId: outcome.agentId,
						messageId: outcome.messageId,
						error:
							'post-stream callback failed: ' +
							((err as Error).message ?? String(err))
					};
				}
			}
			return outcome;
		})
	);

	return {
		replies,
		diagnostics: {
			mentionTokens,
			unresolvedMentionTokens,
			narrowedByMentions
		}
	};
}

/**
 * Stream the original agent message to one specific target agent.
 * Used by the approval-routing path after the user clicks Approve
 * (one call per target, run in parallel by the caller; the
 * approval row transitions to `routed` once every target's stream
 * has terminated, clean or with error).
 *
 * The receiving agent's reply itself becomes a regular agent
 * message in the channel and may trigger its own approval if it
 * mentions yet another agent.
 *
 * Same per-agent stream lifecycle as `streamUserMessage`'s
 * recipients: emits `message_start` / one or more `message_delta`s
 * / `message_end` (clean) or `message_error` (failure) through
 * `emit`, with a pre-allocated message id that the caller uses to
 * persist the row on `message_end` so the DB primary key matches
 * the streamed events.
 */
export async function streamToAgent(
	args: {
		agent_id: string;
		channel_id: string;
		body: string;
	},
	emit: StreamEmit
): Promise<StreamedDispatchedReply | { agentId: string; messageId: string; error: string }> {
	requireChannel(args.channel_id);

	const db = getDb();
	const member = db
		.select({
			id: agents.id,
			name: agents.name,
			connectorType: agents.connectorType,
			config: agents.config
		})
		.from(channelMembers)
		.innerJoin(agents, eq(channelMembers.agentId, agents.id))
		.where(
			and(
				eq(channelMembers.channelId, args.channel_id),
				eq(agents.id, args.agent_id),
				isNull(agents.deletedAt),
				eq(agents.enabled, true)
			)
		)
		.get();

	if (!member) {
		throw new Error(
			`agent ${args.agent_id} is not an enabled member of channel ${args.channel_id}`
		);
	}

	return streamOneAgent(member, args.channel_id, args.body, emit);
}
