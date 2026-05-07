#!/usr/bin/env tsx
/**
 * Seed the local DB.
 *
 * Idempotent: re-running this script does not duplicate seed rows.
 *
 * Today's seed produces:
 *   - One OpenClaw agent ("dixie") talking to the local gateway.
 *   - One Anthropic-stub agent ("muse") with canned replies — for
 *     development of the multi-agent flow without a real API key.
 *   - One 1:1 channel "spike" with just dixie.
 *   - One multi-agent channel "salon" with dixie + muse, used for
 *     exercising the approval flow.
 *
 * Usage:
 *   npm run db:seed
 */

import { eq } from 'drizzle-orm';
import { getDb, closeDb } from '../src/lib/server/db/client.ts';
import { agents, channels, channelMembers } from '../src/lib/server/db/schema.ts';
import { newId } from '../src/lib/server/db/ids.ts';
import { serializeAgentConfig } from '../src/lib/server/db/agent-config.ts';

async function ensureAgent(args: {
	name: string;
	connectorType: string;
	configJson: string;
}): Promise<string> {
	const db = getDb();
	const existing = db.select().from(agents).where(eq(agents.name, args.name)).all();
	if (existing.length > 0) {
		console.log(`seed: agent '${args.name}' already exists (${existing[0]!.id})`);
		return existing[0]!.id;
	}
	const id = newId('agent');
	db.insert(agents)
		.values({
			id,
			name: args.name,
			connectorType: args.connectorType,
			config: args.configJson,
			enabled: true,
			createdAt: Date.now()
		})
		.run();
	console.log(`seed: created agent ${id} (${args.name})`);
	return id;
}

async function ensureChannel(args: { name: string; description: string }): Promise<string> {
	const db = getDb();
	const existing = db.select().from(channels).where(eq(channels.name, args.name)).all();
	if (existing.length > 0) {
		console.log(`seed: channel '${args.name}' already exists (${existing[0]!.id})`);
		return existing[0]!.id;
	}
	const id = newId('channel');
	db.insert(channels)
		.values({ id, name: args.name, description: args.description, createdAt: Date.now() })
		.run();
	console.log(`seed: created channel ${id} (${args.name})`);
	return id;
}

async function ensureMember(channelId: string, agentId: string): Promise<void> {
	const db = getDb();
	const existing = db
		.select()
		.from(channelMembers)
		.where(eq(channelMembers.channelId, channelId))
		.all();
	if (existing.some((m) => m.agentId === agentId)) {
		console.log(`seed: agent ${agentId} already in channel ${channelId}`);
		return;
	}
	db.insert(channelMembers)
		.values({ channelId, agentId, joinedAt: Date.now() })
		.run();
	console.log(`seed: added agent ${agentId} to channel ${channelId}`);
}

async function main(): Promise<void> {
	const dixieId = await ensureAgent({
		name: 'dixie',
		connectorType: 'openclaw',
		configJson: serializeAgentConfig({
			connector_type: 'openclaw',
			base_url: 'http://127.0.0.1:18789/v1',
			token_env_var: 'FINN_OPENCLAW_API_KEY',
			model: 'openclaw'
		})
	});

	const museId = await ensureAgent({
		name: 'muse',
		connectorType: 'anthropic-stub',
		configJson: serializeAgentConfig({
			connector_type: 'anthropic-stub',
			persona: 'a contrarian collaborator',
			replies: [
				'Interessanter Punkt — aber: @dixie, was hältst du davon?',
				'Drei Einwände: Kontext, Skalierung, Motivation.',
				'Notiert. Ich bleibe skeptisch.'
			]
		})
	});

	const spikeId = await ensureChannel({
		name: 'spike',
		description: 'Spike channel — one user, one agent (dixie), straight 1:1 chat.'
	});
	await ensureMember(spikeId, dixieId);

	const salonId = await ensureChannel({
		name: 'salon',
		description: 'Multi-agent room: dixie + muse. Used to exercise the approval flow.'
	});
	await ensureMember(salonId, dixieId);
	await ensureMember(salonId, museId);

	closeDb();
}

main().catch((err) => {
	console.error(err);
	closeDb();
	process.exit(1);
});
