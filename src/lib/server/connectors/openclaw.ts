/**
 * OpenClaw connector — POSTs chat turns to an OpenClaw Gateway via its
 * OpenAI-compatible HTTP API (`POST /v1/chat/completions`).
 *
 * Authentication and scope:
 *   See docs/decisions/0001-openclaw-connector-auth.md for the full
 *   rationale. Short version: finn is a scoped operator UI. It always
 *   sends `x-openclaw-scopes` declaring the narrowed set it needs;
 *   gateways in `trusted-proxy` mode honor that, gateways in `token`
 *   mode harmlessly ignore it (transitional posture).
 *
 * Session continuity:
 *   See docs/decisions/0002-session-key-format.md (original) and
 *   docs/decisions/0012-agent-aware-session-key.md (current).
 *
 *   The session-key shape depends on whether the connector's
 *   `model` field names a specific agent:
 *
 *     - `model: "openclaw"` (or `"openclaw/default"`)
 *       → send `finn:<channel_id>` (ADR-0002's original shape).
 *         The gateway wraps it as `agent:<resolved-default>:finn:<channel_id>`
 *         using whatever default-agent id is currently configured.
 *         This keeps continuity stable across renames of the
 *         default-agent id and matches the gateway's stateful
 *         session store.
 *
 *     - `model: "openclaw/<agentId>"`
 *       → send `agent:<agentId>:finn:<channel_id>`. The explicit
 *         `agent:<agentId>:` prefix is what the gateway's session-
 *         key parser (`parseAgentSessionKey()` upstream) recognises
 *         and uses to scope the session to that agent. Without it,
 *         the gateway resolves the agent before the session lookup
 *         and the multi-agent case breaks: an existing
 *         `agent:<otherAgent>:finn:<channel_id>` session captures
 *         the call regardless of the `model` field.
 *
 *   In both cases, each (agent, finn channel) pair maps to one
 *   stable OpenClaw-side session.
 *
 * Configuration:
 *   The connector receives an OpenclawConfig object (see
 *   db/agent-config.ts) on every call. base_url and model come from the
 *   agent's row in the DB. The bearer token is read from the env var
 *   named in `config.token_env_var` (default `FINN_OPENCLAW_API_KEY`),
 *   which is loaded from ~/finn-data/secrets/.env at process start.
 *   The token never lives in the DB.
 *
 * For the spike, the connector is still stateless on the *finn* side:
 *   we do not yet send conversation history in the request body. The
 *   continuity comes from OpenClaw recognizing a returning session-key
 *   and resuming the agent's session on the gateway side. Once finn
 *   has its own DB, we will additionally pass message history through
 *   for connectors that prefer client-managed history.
 *
 * Streaming-only since ADR-0013 phases 2 + 3:
 *   This connector exposes `streamReply` only. The earlier
 *   non-streaming `send` path was removed once both dispatch entry
 *   points (`streamUserMessage`, `streamToAgent`) consumed the
 *   streaming surface end-to-end.
 */

import type { OpenclawConfig } from '../db/agent-config.ts';
import { parseSseStream, type SseEvent } from './sse-parser.ts';

/**
 * Scope set finn declares on every OpenClaw request.
 * MUST stay in sync with docs/decisions/0001-openclaw-connector-auth.md
 * §"Scope set finn will request". Widening this is an ADR-level decision,
 * not a code change.
 */
const FINN_SCOPES = ['operator.read', 'operator.write'].join(' ');

/**
 * Prefix for OpenClaw session keys created by finn.
 * MUST stay in sync with docs/decisions/0002-session-key-format.md
 * and docs/decisions/0012-agent-aware-session-key.md.
 * Changing this would orphan all existing OpenClaw-side sessions for
 * existing finn channels.
 */
const FINN_SESSION_PREFIX = 'finn';

/**
 * Extract the explicit agent id from the OpenAI `model` field, if any.
 *
 * Returns:
 *   - `null` for `openclaw`, `openclaw/default`, empty, or unrecognised
 *     values — caller should treat this as "the gateway picks the
 *     default agent" and emit a non-prefixed session-key.
 *   - The `<agentId>` substring for `openclaw/<agentId>`.
 *
 * The gateway also accepts the compatibility alias forms `openclaw:<id>`
 * and `agent:<id>` (see upstream OpenAI HTTP API docs); we recognise
 * those too so the same session-key derivation works for ports of
 * other tooling.
 */
function explicitAgentIdFromModel(model: string): string | null {
	const trimmed = (model ?? '').trim();
	if (trimmed === '' || trimmed === 'openclaw' || trimmed === 'openclaw/default') {
		return null;
	}
	const match =
		trimmed.match(/^openclaw[:/](?<id>[a-z0-9][a-z0-9_-]{0,63})$/i) ??
		trimmed.match(/^agent:(?<id>[a-z0-9][a-z0-9_-]{0,63})$/i);
	const id = match?.groups?.id;
	if (!id) return null;
	if (id.toLowerCase() === 'default') return null;
	return id;
}

/**
 * Build the session-key string sent to OpenClaw.
 *
 * Two shapes, depending on whether the `model` field names a specific
 * agent (see file-level docblock for the rationale):
 *
 *   - explicit agent: `agent:<agentId>:finn:<channel_id>` — the
 *     `agent:<agentId>:` prefix is what the gateway's session-key
 *     parser recognises and uses to scope the session.
 *   - default agent: `finn:<channel_id>` — ADR-0002's original
 *     shape; the gateway wraps it with the resolved default-agent
 *     id at session-store time.
 */
function sessionKeyFor(explicitAgentId: string | null, channelId: string): string {
	if (explicitAgentId) {
		return `agent:${explicitAgentId}:${FINN_SESSION_PREFIX}:${channelId}`;
	}
	return `${FINN_SESSION_PREFIX}:${channelId}`;
}

type ChatMessage = {
	role: 'system' | 'user' | 'assistant';
	content: string;
};

const SYSTEM_PROMPT =
	"You are an assistant being addressed through 'finn', a multi-agent " +
	'chat router. Reply concisely; the user is testing channel plumbing.';

export type OpenclawStreamArgs = {
	channelId: string;
	body: string;
	config: OpenclawConfig;
};

/**
 * Stream the agent's reply to a single channel turn.
 *
 * Issues `POST /chat/completions` with `stream: true` plus the
 * ADR-0001 scopes header and ADR-0002 + ADR-0012 agent-aware
 * session-key, parses the SSE response, and yields content deltas
 * as they arrive.
 *
 * OpenClaw passes Anthropic / Ollama SSE through directly, so for
 * agents pointing at those backends the stream is genuinely
 * token-by-token. See ADR-0013 §"Backend streaming maturity".
 *
 * Throws on:
 *   - HTTP non-2xx (with body excerpt for diagnosis).
 *   - Mid-stream upstream errors (`finish_reason: "error"` frame).
 *   - Stream end without any content (caller surfaces as
 *     `message_error`).
 */
async function* streamReply(
	args: OpenclawStreamArgs
): AsyncGenerator<SseEvent, void, void> {
	const { base_url: baseUrl, model, token_env_var: tokenEnvVar } = args.config;
	const apiKey = process.env[tokenEnvVar] ?? '';

	const messages: ChatMessage[] = [
		{ role: 'system', content: SYSTEM_PROMPT },
		{ role: 'user', content: args.body }
	];

	const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

	const explicitAgentId = explicitAgentIdFromModel(model);

	const headers: Record<string, string> = {
		'content-type': 'application/json',
		// Hint to upstream proxies that this is a streaming response.
		accept: 'text/event-stream',
		// See ADR-0001. Always declare the scope.
		'x-openclaw-scopes': FINN_SCOPES,
		// See ADR-0002 + ADR-0012. Same session-key derivation as send().
		'x-openclaw-session-key': sessionKeyFor(explicitAgentId, args.channelId)
	};
	if (apiKey) {
		headers.authorization = `Bearer ${apiKey}`;
	}

	const res = await fetch(url, {
		method: 'POST',
		headers,
		body: JSON.stringify({ model, messages, stream: true })
	});

	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(`openclaw ${res.status}: ${text.slice(0, 200)}`);
	}

	yield* parseSseStream(res.body);
}

export const openclawConnector = { streamReply };
