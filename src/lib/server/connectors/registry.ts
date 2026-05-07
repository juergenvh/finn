/**
 * Connector registry — DB-driven dispatch.
 *
 * Given a finn channel id, the registry finds the channel's member
 * agents, looks up each agent's connector config, and dispatches the
 * user message to the appropriate connector implementation.
 *
 * For the spike (1:1 channel, one agent), this resolves to one connector
 * call. The shape generalises to multi-agent channels: dispatch becomes
 * "fan out to each member"; agent-to-agent traffic then goes through the
 * approval flow before another connector call.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '../db/client.ts';
import { agents, channelMembers, channels } from '../db/schema.ts';
import { parseAgentConfig } from '../db/agent-config.ts';
import { openclawConnector } from './openclaw.ts';

export type ConnectorContext = {
	channel_id: string;
	body: string;
};

const ECHO = (process.env.FINN_ECHO_ONLY ?? '').toLowerCase() === '1';

export async function dispatchUserMessage(ctx: ConnectorContext): Promise<string | null> {
	if (ECHO) {
		return `echo: ${ctx.body}`;
	}

	const db = getDb();

	// Channel must exist and not be soft-deleted.
	const channel = db
		.select()
		.from(channels)
		.where(and(eq(channels.id, ctx.channel_id), isNull(channels.deletedAt)))
		.get();
	if (!channel) {
		throw new Error(`unknown or deleted channel: ${ctx.channel_id}`);
	}

	// Find member agents (joined with agents table, filtering soft-deleted/disabled).
	const memberAgents = db
		.select({
			id: agents.id,
			name: agents.name,
			connectorType: agents.connectorType,
			config: agents.config
		})
		.from(channelMembers)
		.innerJoin(agents, eq(channelMembers.agentId, agents.id))
		.where(
			and(
				eq(channelMembers.channelId, ctx.channel_id),
				isNull(agents.deletedAt),
				eq(agents.enabled, true)
			)
		)
		.all();

	if (memberAgents.length === 0) {
		throw new Error(`channel ${ctx.channel_id} has no enabled agent members`);
	}
	if (memberAgents.length > 1) {
		// Multi-agent channels need the approval flow before a connector
		// is called for cross-agent traffic. Spike sticks to 1:1.
		throw new Error(
			`channel ${ctx.channel_id} has ${memberAgents.length} agent members; ` +
				`multi-agent dispatch requires the approval flow (not implemented yet)`
		);
	}

	const agent = memberAgents[0]!;

	if (agent.connectorType === 'openclaw') {
		const config = parseAgentConfig(agent.connectorType, agent.config);
		if (config.connector_type !== 'openclaw') {
			throw new Error(`agent ${agent.id} config schema mismatch`);
		}
		return openclawConnector.send({
			channelId: ctx.channel_id,
			body: ctx.body,
			config
		});
	}

	throw new Error(`unknown connector_type for agent ${agent.id}: ${agent.connectorType}`);
}
