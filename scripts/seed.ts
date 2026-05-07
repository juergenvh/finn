#!/usr/bin/env tsx
/**
 * Seed the local DB with the minimum data needed for finn to be useful
 * out of the box: one OpenClaw-connected agent (the local default
 * agent, currently "dixie"), and one channel containing it.
 *
 * Idempotent: re-running this script does not duplicate seed rows. It
 * checks for an existing agent by name and an existing channel by name
 * before inserting.
 *
 * Usage:
 *   npm run db:seed
 */

import { eq } from 'drizzle-orm';
import { getDb, closeDb } from '../src/lib/server/db/client.ts';
import { agents, channels, channelMembers } from '../src/lib/server/db/schema.ts';
import { newId } from '../src/lib/server/db/ids.ts';
import { serializeAgentConfig } from '../src/lib/server/db/agent-config.ts';

const SEED_AGENT_NAME = 'dixie';
const SEED_CHANNEL_NAME = 'spike';

async function main(): Promise<void> {
	const db = getDb();
	const now = Date.now();

	// --- agent ---
	let agentId: string;
	const existingAgent = db.select().from(agents).where(eq(agents.name, SEED_AGENT_NAME)).all();
	if (existingAgent.length > 0) {
		agentId = existingAgent[0]!.id;
		console.log(`seed: agent '${SEED_AGENT_NAME}' already exists (${agentId}), skipping`);
	} else {
		agentId = newId('agent');
		const config = serializeAgentConfig({
			connector_type: 'openclaw',
			base_url: 'http://127.0.0.1:18789/v1',
			token_env_var: 'FINN_OPENCLAW_API_KEY',
			model: 'openclaw'
		});
		db.insert(agents)
			.values({
				id: agentId,
				name: SEED_AGENT_NAME,
				connectorType: 'openclaw',
				config,
				enabled: true,
				createdAt: now
			})
			.run();
		console.log(`seed: created agent ${agentId} (${SEED_AGENT_NAME})`);
	}

	// --- channel ---
	let channelId: string;
	const existingChannel = db
		.select()
		.from(channels)
		.where(eq(channels.name, SEED_CHANNEL_NAME))
		.all();
	if (existingChannel.length > 0) {
		channelId = existingChannel[0]!.id;
		console.log(`seed: channel '${SEED_CHANNEL_NAME}' already exists (${channelId}), skipping`);
	} else {
		channelId = newId('channel');
		db.insert(channels)
			.values({
				id: channelId,
				name: SEED_CHANNEL_NAME,
				description: 'Spike channel — one user, one agent (dixie), straight 1:1 chat.',
				createdAt: now
			})
			.run();
		console.log(`seed: created channel ${channelId} (${SEED_CHANNEL_NAME})`);
	}

	// --- membership ---
	const existingMember = db
		.select()
		.from(channelMembers)
		.where(eq(channelMembers.channelId, channelId))
		.all();
	const alreadyMember = existingMember.some((row) => row.agentId === agentId);
	if (alreadyMember) {
		console.log(`seed: agent already in channel, skipping membership insert`);
	} else {
		db.insert(channelMembers)
			.values({ channelId, agentId, joinedAt: now })
			.run();
		console.log(`seed: added agent ${agentId} to channel ${channelId}`);
	}

	closeDb();
}

main().catch((err) => {
	console.error(err);
	closeDb();
	process.exit(1);
});
