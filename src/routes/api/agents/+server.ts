/**
 * GET  /api/agents              — list agents (default: non-deleted only).
 * POST /api/agents              — create an agent; body validated by zod.
 *
 * Query: ?include_archived=1 returns soft-deleted rows too.
 */

import { isNull, eq } from 'drizzle-orm';
import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db/client';
import { agents } from '$lib/server/db/schema';
import { newId } from '$lib/server/db/ids';
import {
	ConnectorConfigSchema,
	serializeAgentConfig,
	type ConnectorConfig
} from '$lib/server/db/agent-config';
import { broadcastStateChange } from '$lib/server/ws/attach';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	const includeArchived = url.searchParams.get('include_archived') === '1';
	const db = getDb();
	const baseQuery = db
		.select({
			id: agents.id,
			name: agents.name,
			connectorType: agents.connectorType,
			enabled: agents.enabled,
			deletedAt: agents.deletedAt
		})
		.from(agents);

	const rows = includeArchived ? baseQuery.all() : baseQuery.where(isNull(agents.deletedAt)).all();
	return json({ agents: rows });
};

/**
 * Body shape expected:
 * {
 *   name: string,
 *   enabled?: boolean (default true),
 *   config: <connector-config-schema>   // discriminated by connector_type
 * }
 *
 * The connector_type is read off `config.connector_type` and stored
 * separately on the agents row so the discriminator can drive lookups
 * cheaply. Validation is the canonical Zod schema in agent-config.ts.
 */
const CreateAgentSchema = z.object({
	name: z.string().trim().min(1).max(80),
	enabled: z.boolean().default(true),
	config: z.record(z.string(), z.unknown())
});

export const POST: RequestHandler = async ({ request }) => {
	const raw = await request.json().catch(() => null);
	const outer = CreateAgentSchema.safeParse(raw);
	if (!outer.success) {
		throw error(400, outer.error.issues[0]?.message ?? 'invalid body');
	}
	const { name, enabled, config: rawConfig } = outer.data;

	const inner = ConnectorConfigSchema.safeParse(rawConfig);
	if (!inner.success) {
		throw error(400, `connector config invalid: ${inner.error.issues[0]?.message ?? 'unknown'}`);
	}
	const config: ConnectorConfig = inner.data;

	const db = getDb();

	const clash = db.select({ id: agents.id }).from(agents).where(eq(agents.name, name)).all();
	if (clash.some(() => true)) {
		throw error(409, `agent name '${name}' already exists`);
	}

	const id = newId('agent');
	db.insert(agents)
		.values({
			id,
			name,
			connectorType: config.connector_type,
			config: serializeAgentConfig(config),
			enabled,
			createdAt: Date.now()
		})
		.run();

	broadcastStateChange({ type: 'state_changed', entity: 'agent', action: 'created', id });
	return json(
		{ id, name, connectorType: config.connector_type, enabled },
		{ status: 201 }
	);
};
