/**
 * OpenAI-compatible connector — POSTs chat turns to any backend that
 * exposes a `/chat/completions` endpoint with OpenAI's wire format.
 *
 * Used for backends that are *their own product* (Wintermute, Open
 * WebUI, vLLM, llama.cpp's server, …) rather than another OpenClaw
 * gateway. Distinct from the `openclaw` connector in three ways:
 *
 *  1. **No `x-openclaw-*` headers.** This is plain OpenAI; we send
 *     only what OpenAI clients send.
 *  2. **No agent routing in the `model` field.** The backend either
 *     ignores `model` entirely (Wintermute) or uses it to pick a
 *     model on its own side; either way, no `openclaw/<id>` form.
 *  3. **Continuity via OpenAI's standard `user` field.** Set to the
 *     finn channel id, so a backend that maintains per-`user`
 *     sessions (Wintermute maps it to its `conversation_id`) can pin
 *     channel-scoped state. Backends that ignore `user` simply lose
 *     continuity, the same way they would with any stateless
 *     OpenAI client.
 *
 * Authentication is a single bearer token, read at call time from
 * `process.env[token_env_var]` (default `FINN_OPENAI_COMPAT_API_KEY`).
 * The token never lives in the DB. See ADR-0001 for the rationale on
 * env-var-only secret storage; the same posture as the `openclaw`
 * connector applies here.
 *
 * Streaming-only since ADR-0013 phases 2 + 3:
 * This connector exposes `streamReply` only. The earlier
 * non-streaming `send` path was removed once both dispatch entry
 * points (`streamUserMessage`, `streamToAgent`) consumed the
 * streaming surface end-to-end.
 */

import type { OpenAICompatibleConfig } from '../db/agent-config.ts';
import { parseSseStream, type SseEvent } from './sse-parser.ts';

type ChatMessage = {
	role: 'system' | 'user' | 'assistant';
	content: string;
};

const SYSTEM_PROMPT =
	"You are an assistant being addressed through 'finn', a multi-agent " +
	'chat router. Reply concisely; the user is testing channel plumbing.';

export type OpenAICompatibleStreamArgs = {
	channelId: string;
	body: string;
	config: OpenAICompatibleConfig;
};

/**
 * Stream the agent's reply to a single channel turn.
 *
 * Issues `POST /chat/completions` with `stream: true`, parses the
 * SSE response, and yields content deltas as they arrive.
 *
 * The first chunk's arrival latency is the *real* first-byte
 * latency of the upstream agent (Anthropic SSE for Wintermute,
 * Ollama SSE for local backends). For backends that don't
 * actually stream token-by-token (Wintermute today; see ADR-0013
 * §"Backend streaming maturity"), the entire reply arrives in a
 * single chunk — still better than non-streaming because the
 * dispatcher unblocks the next agent the moment this one's stream
 * terminates.
 *
 * Throws on:
 *   - HTTP non-2xx (with body excerpt for diagnosis).
 *   - Mid-stream upstream errors (`finish_reason: "error"` frame).
 *   - Stream end without any content (caller surfaces as
 *     `message_error`).
 */
async function* streamReply(
	args: OpenAICompatibleStreamArgs
): AsyncGenerator<SseEvent, void, void> {
	const {
		base_url: baseUrl,
		model_hint: modelHint,
		token_env_var: tokenEnvVar
	} = args.config;
	const apiKey = process.env[tokenEnvVar] ?? '';

	const messages: ChatMessage[] = [
		{ role: 'system', content: SYSTEM_PROMPT },
		{ role: 'user', content: args.body }
	];

	const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

	const headers: Record<string, string> = {
		'content-type': 'application/json',
		// Hint to upstream proxies that this is a streaming response;
		// the actual content-type comes back as text/event-stream.
		accept: 'text/event-stream'
	};
	if (apiKey) {
		headers.authorization = `Bearer ${apiKey}`;
	}

	const requestBody = {
		model: modelHint,
		messages,
		user: args.channelId,
		stream: true
	};

	const res = await fetch(url, {
		method: 'POST',
		headers,
		body: JSON.stringify(requestBody)
	});

	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(
			`openai-compatible ${res.status}: ${text.slice(0, 200)}`
		);
	}

	yield* parseSseStream(res.body);
}

export const openAICompatibleConnector = { streamReply };
