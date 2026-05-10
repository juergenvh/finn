/**
 * Agent connector configuration — Zod schemas + serialization helpers.
 *
 * Each connector_type has its own schema (discriminated union on
 * `connector_type`). The DB stores the config as JSON text; this module
 * is the single place that parses and re-serialises.
 *
 * Adding a new connector:
 *   1. Add a Zod schema below (e.g. AnthropicConfigSchema).
 *   2. Add it to ConnectorConfigSchema's discriminator.
 *   3. Implement the connector under src/lib/server/connectors/.
 *   4. Update tests / seed data.
 */

import { z } from 'zod';

/* ------------------------------------------------------ openclaw connector */

export const OpenclawConfigSchema = z.object({
	connector_type: z.literal('openclaw'),
	/** Base URL like http://127.0.0.1:18789/v1. The connector appends
	 * `/chat/completions` itself. */
	base_url: z.string().url(),
	/** Name of the env var that holds the bearer token. The token itself
	 * NEVER lives in the DB. We read process.env[token_env_var] at
	 * connector-call time. */
	token_env_var: z.string().min(1).default('FINN_OPENCLAW_API_KEY'),
	/** OpenClaw model id (e.g. "openclaw" for the default agent, or
	 * "openclaw/<agentId>"). */
	model: z.string().min(1).default('openclaw'),
	/** Optional. When set, the connector pins this agent to the named
	 * upstream session (e.g. "finn", "sagesmith") regardless of which
	 * finn channel it's used in. Drops the channel-id component from
	 * the session-key. Use when you want the same upstream agent to
	 * maintain one conversation across channels, OR to share an upstream
	 * session with a non-finn OpenClaw client (TUI, webchat) by using
	 * the same name on both sides. See ADR-0017. */
	session_override: z
		.string()
		.min(1)
		.max(64)
		.regex(
			/^[a-z0-9][a-z0-9_-]{0,63}$/i,
			'session_override must be a session-key-safe identifier (alnum + dash + underscore, leading alnum, max 64 chars)'
		)
		.optional()
});

export type OpenclawConfig = z.infer<typeof OpenclawConfigSchema>;

/* ----------------------------------------- openai-compatible connector */

/**
 * OpenAI-compatible connector configuration.
 *
 * For backends that expose an OpenAI-style `/chat/completions`
 * endpoint of their own — e.g. Wintermute's `/v1/*` adapter
 * (see https://github.com/juergenvh/wintermute, docs/OPENAI-COMPAT.md),
 * Open WebUI, LobeChat, LibreChat, vLLM, llama.cpp's server, etc.
 *
 * The wire is intentionally vanilla OpenAI: no `x-openclaw-*`
 * headers, no agent-routing in the model field, no model splitting.
 * If a backend speaks the OpenAI Chat Completions wire, this
 * connector talks to it.
 *
 * Conversation continuity uses OpenAI's standard `user` body field,
 * set to the finn channel id so the backend can pin per-channel
 * sessions on its side (Wintermute does, others may not).
 */
export const OpenAICompatibleConfigSchema = z.object({
	connector_type: z.literal('openai-compatible'),
	/** Base URL ending in /v1 (or whatever the backend's OpenAI-style
	 * root is). The connector appends `/chat/completions` itself. */
	base_url: z.string().url(),
	/** Name of the env var that holds the bearer token. The token
	 * itself NEVER lives in the DB. We read process.env[token_env_var]
	 * at connector-call time. */
	token_env_var: z.string().min(1).default('FINN_OPENAI_COMPAT_API_KEY'),
	/** Value sent in the OpenAI `model` body field. The OpenAI wire
	 * requires *something* there even when the backend ignores it
	 * (Wintermute does); some backends use it as a router key. The
	 * default "default" works against backends that ignore the field;
	 * use the backend-specific value (e.g. "wintermute",
	 * "meta-llama-3.1-8b-instruct") when the backend respects it. */
	model_hint: z.string().min(1).default('default')
});

export type OpenAICompatibleConfig = z.infer<typeof OpenAICompatibleConfigSchema>;

/* ---------------------------------------------- anthropic-stub connector */

import { AnthropicStubConfigSchema } from '../connectors/anthropic-stub.ts';
export { AnthropicStubConfigSchema };
export type { AnthropicStubConfig } from '../connectors/anthropic-stub.ts';

/* -------------------------------------------------- discriminated union */

/** Single connector schema. Add new connectors as additional branches. */
export const ConnectorConfigSchema = z.discriminatedUnion('connector_type', [
	OpenclawConfigSchema,
	OpenAICompatibleConfigSchema,
	AnthropicStubConfigSchema
]);

export type ConnectorConfig = z.infer<typeof ConnectorConfigSchema>;

/* --------------------------------------------------- (de)serialization */

/** Parse the DB-stored JSON config. Throws on invalid input. */
export function parseAgentConfig(connectorType: string, json: string): ConnectorConfig {
	const raw = JSON.parse(json) as Record<string, unknown>;
	return ConnectorConfigSchema.parse({ ...raw, connector_type: connectorType });
}

/** Serialize a typed config to DB-storable JSON.
 * The `connector_type` discriminator is stored separately on the agents
 * row (not redundantly in the JSON), so we strip it from the payload. */
export function serializeAgentConfig(config: ConnectorConfig): string {
	const { connector_type: _ignored, ...rest } = config;
	void _ignored;
	return JSON.stringify(rest);
}
