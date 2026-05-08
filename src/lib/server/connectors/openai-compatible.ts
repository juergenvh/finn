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
 * Streaming is not yet exercised on this path. The connector requests
 * `stream: false` and consumes the JSON body. When finn grows real
 * progressive rendering (issue #3), both this and the `openclaw`
 * connector get streaming together.
 */

import type { OpenAICompatibleConfig } from '../db/agent-config.ts';

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

export type OpenAICompatibleSendArgs = {
	channelId: string;
	body: string;
	config: OpenAICompatibleConfig;
};

async function send(args: OpenAICompatibleSendArgs): Promise<string> {
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
		'content-type': 'application/json'
	};
	if (apiKey) {
		headers.authorization = `Bearer ${apiKey}`;
	}

	const requestBody = {
		model: modelHint,
		messages,
		// Standard OpenAI continuity hint. Backends that pin per-user
		// sessions (Wintermute) use this to scope conversation state;
		// backends that ignore it simply don't, and we keep parity
		// with how a vanilla OpenAI client would be used.
		user: args.channelId,
		stream: false
	};

	const res = await fetch(url, {
		method: 'POST',
		headers,
		body: JSON.stringify(requestBody)
	});

	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(`openai-compatible ${res.status}: ${text.slice(0, 200)}`);
	}

	const data = (await res.json()) as ChatCompletionResponse;
	const content = data.choices?.[0]?.message?.content;
	if (typeof content !== 'string' || content.length === 0) {
		throw new Error('openai-compatible returned empty content');
	}
	return content;
}

export const openAICompatibleConnector = { send };
