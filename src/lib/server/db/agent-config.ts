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
	model: z.string().min(1).default('openclaw')
});

export type OpenclawConfig = z.infer<typeof OpenclawConfigSchema>;

/* -------------------------------------------------- discriminated union */

/** Single connector schema. Add new connectors as additional branches. */
export const ConnectorConfigSchema = z.discriminatedUnion('connector_type', [
	OpenclawConfigSchema
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
