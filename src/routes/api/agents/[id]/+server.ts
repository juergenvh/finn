/**
 * GET    /api/agents/:id   — fetch single (includes deserialised config).
 * PATCH  /api/agents/:id   — update name / enabled / config.
 *                            connector_type is NOT changeable post-creation.
 * DELETE /api/agents/:id   — soft-delete (per ADR-0004).
 */

import { eq } from 'drizzle-orm';
import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db/client';
import { agents } from '$lib/server/db/schema';
import {
	ConnectorConfigSchema,
	parseAgentConfig,
	serializeAgentConfig
} from '$lib/server/db/agent-config';
import { broadcastStateChange } from '$lib/server/ws/attach';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	const db = getDb();
	const row = db.select().from(agents).where(eq(agents.id, params.id)).get();
	if (!row) throw error(404, 'agent not found');

	let config = null as unknown;
	try {
		config = parseAgentConfig(row.connectorType, row.config);
	} catch (err) {
		// Surface the raw DB content if it can't be parsed; this lets
		// the UI show a helpful error rather than silently dropping.
		config = { _parse_error: (err as Error).message, _raw: row.config };
	}

	return json({
		id: row.id,
		name: row.name,
		connectorType: row.connectorType,
		enabled: row.enabled,
		createdAt: row.createdAt,
		deletedAt: row.deletedAt,
		config
	});
};

const PatchSchema = z.object({
	name: z.string().trim().min(1).max(80).optional(),
	enabled: z.boolean().optional(),
	config: z.record(z.string(), z.unknown()).optional()
});

export const PATCH: RequestHandler = async ({ params, request }) => {
	const raw = await request.json().catch(() => null);
	const parsed = PatchSchema.safeParse(raw);
	if (!parsed.success) {
		throw error(400, parsed.error.issues[0]?.message ?? 'invalid body');
	}
	const updates = parsed.data;
	if (Object.keys(updates).length === 0) throw error(400, 'no fields to update');

	const db = getDb();
	const existing = db.select().from(agents).where(eq(agents.id, params.id)).get();
	if (!existing) throw error(404, 'agent not found');
	if (existing.deletedAt !== null) throw error(410, 'agent is archived');

	if (updates.name && updates.name !== existing.name) {
		const clash = db.select({ id: agents.id }).from(agents).where(eq(agents.name, updates.name)).all();
		if (clash.some((c) => c.id !== params.id)) {
			throw error(409, `agent name '${updates.name}' already exists`);
		}
	}

	let configJson: string | undefined;
	if (updates.config !== undefined) {
		// Force the connector_type discriminator to the existing one;
		// changing it is forbidden because it would invalidate the
		// schema shape.
		const candidate = { ...updates.config, connector_type: existing.connectorType };
		const inner = ConnectorConfigSchema.safeParse(candidate);
		if (!inner.success) {
			throw error(400, `connector config invalid: ${inner.error.issues[0]?.message ?? 'unknown'}`);
		}
		configJson = serializeAgentConfig(inner.data);
	}

	const next: Partial<typeof existing> = {};
	if (updates.name !== undefined) next.name = updates.name;
	if (updates.enabled !== undefined) next.enabled = updates.enabled;
	if (configJson !== undefined) next.config = configJson;
	db.update(agents).set(next).where(eq(agents.id, params.id)).run();

	broadcastStateChange({ type: 'state_changed', entity: 'agent', action: 'updated', id: params.id });
	return json({ id: params.id, ...next });
};

export const DELETE: RequestHandler = async ({ params }) => {
	const db = getDb();
	const existing = db.select().from(agents).where(eq(agents.id, params.id)).get();
	if (!existing) throw error(404, 'agent not found');
	if (existing.deletedAt !== null) {
		return json({ id: params.id, deleted_at: existing.deletedAt });
	}

	const now = Date.now();
	db.update(agents).set({ deletedAt: now }).where(eq(agents.id, params.id)).run();

	broadcastStateChange({ type: 'state_changed', entity: 'agent', action: 'deleted', id: params.id });
	return json({ id: params.id, deleted_at: now });
};
