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
 *   See docs/decisions/0002-session-key-format.md. Each finn channel
 *   maps to one stable OpenClaw agent session via the
 *   `x-openclaw-session-key: finn:<channel_id>` header. Without this,
 *   every relayed turn would land in a fresh agent session and the
 *   agent would re-load its memory on every message.
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
 */

import type { OpenclawConfig } from '../db/agent-config.ts';

/**
 * Scope set finn declares on every OpenClaw request.
 * MUST stay in sync with docs/decisions/0001-openclaw-connector-auth.md
 * §"Scope set finn will request". Widening this is an ADR-level decision,
 * not a code change.
 */
const FINN_SCOPES = ['operator.read', 'operator.write'].join(' ');

/**
 * Prefix for OpenClaw session keys created by finn.
 * MUST stay in sync with docs/decisions/0002-session-key-format.md.
 * Changing this would orphan all existing OpenClaw-side sessions for
 * existing finn channels.
 */
const FINN_SESSION_PREFIX = 'finn';

function sessionKeyFor(channelId: string): string {
	return `${FINN_SESSION_PREFIX}:${channelId}`;
}

type ChatMessage = {
	role: 'system' | 'user' | 'assistant';
	content: string;
};

type ChatCompletionResponse = {
	choices: Array<{
		message?: { content?: string };
	}>;
};

const SYSTEM_PROMPT =
	"You are an assistant being addressed through 'finn', a multi-agent " +
	'chat router. Reply concisely; the user is testing channel plumbing.';

export type OpenclawSendArgs = {
	channelId: string;
	body: string;
	config: OpenclawConfig;
};

async function send(args: OpenclawSendArgs): Promise<string> {
	const { base_url: baseUrl, model, token_env_var: tokenEnvVar } = args.config;
	const apiKey = process.env[tokenEnvVar] ?? '';

	const messages: ChatMessage[] = [
		{ role: 'system', content: SYSTEM_PROMPT },
		{ role: 'user', content: args.body }
	];

	const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

	const headers: Record<string, string> = {
		'content-type': 'application/json',
		// See ADR-0001. Always declare the scope, even when calling a
		// gateway that will ignore the header — keeps the contract
		// uniform across gateway auth modes.
		'x-openclaw-scopes': FINN_SCOPES,
		// See ADR-0002. Pin one OpenClaw-side session per finn channel
		// so that the agent perceives a continuous conversation.
		'x-openclaw-session-key': sessionKeyFor(args.channelId)
	};
	if (apiKey) {
		headers.authorization = `Bearer ${apiKey}`;
	}

	const res = await fetch(url, {
		method: 'POST',
		headers,
		body: JSON.stringify({ model, messages, stream: false })
	});

	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(`openclaw ${res.status}: ${text.slice(0, 200)}`);
	}

	const data = (await res.json()) as ChatCompletionResponse;
	const content = data.choices?.[0]?.message?.content;
	if (typeof content !== 'string' || content.length === 0) {
		throw new Error('openclaw returned empty content');
	}
	return content;
}

export const openclawConnector = { send };
