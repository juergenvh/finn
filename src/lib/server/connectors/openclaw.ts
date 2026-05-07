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
 * Configuration via env vars (loaded from ~/finn-data/secrets/.env;
 * see docs/decisions/0001 §Token storage):
 *
 *   FINN_OPENCLAW_BASE_URL   default: http://127.0.0.1:18789/v1
 *   FINN_OPENCLAW_API_KEY    bearer token for the gateway
 *                            (required while any reachable gateway runs
 *                            in `token` mode; may become optional after
 *                            the trusted-proxy migration)
 *   FINN_OPENCLAW_MODEL      default: openclaw  (= configured default agent)
 *
 * For the spike, this is stateless: each user message becomes a one-shot
 * chat-completion request. No history, no tool-use, no streaming.
 * Once the DB and channel routing are in, conversation history will live
 * server-side and be passed through on every call.
 */

const DEFAULT_BASE_URL = 'http://127.0.0.1:18789/v1';
const DEFAULT_MODEL = 'openclaw';

/**
 * Scope set finn declares on every OpenClaw request.
 * MUST stay in sync with docs/decisions/0001-openclaw-connector-auth.md
 * §"Scope set finn will request". Widening this is an ADR-level decision,
 * not a code change.
 */
const FINN_SCOPES = ['operator.read', 'operator.write'].join(' ');

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

function getConfig() {
	const baseUrl = process.env.FINN_OPENCLAW_BASE_URL ?? DEFAULT_BASE_URL;
	const apiKey = process.env.FINN_OPENCLAW_API_KEY ?? '';
	const model = process.env.FINN_OPENCLAW_MODEL ?? DEFAULT_MODEL;
	return { baseUrl, apiKey, model };
}

async function send(userBody: string): Promise<string> {
	const { baseUrl, apiKey, model } = getConfig();

	const messages: ChatMessage[] = [
		{ role: 'system', content: SYSTEM_PROMPT },
		{ role: 'user', content: userBody }
	];

	const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

	const headers: Record<string, string> = {
		'content-type': 'application/json',
		// See ADR-0001. Always declare the scope, even when calling a
		// gateway that will ignore the header — keeps the contract
		// uniform across gateway auth modes.
		'x-openclaw-scopes': FINN_SCOPES
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
