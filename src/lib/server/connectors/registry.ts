/**
 * Connector registry — DB-driven dispatch.
 *
 * Two entry points:
 *
 *   dispatchUserMessage(channel_id, body)
 *     Fans out to every enabled member agent of the channel. User
 *     messages do not require approval (ADR-0005 §1).
 *
 *   dispatchToAgent(agent_id, channel_id, body)
 *     Routes a single message to one specific agent. This is what
 *     the approval flow calls after a `routed` transition.
 *
 * Both eventually call the same per-connector `send()` implementation;
 * they only differ in how they fan out.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '../db/client.ts';
import { agents, channelMembers, channels } from '../db/schema.ts';
import { parseAgentConfig } from '../db/agent-config.ts';
import { openclawConnector } from './openclaw.ts';
import { anthropicStubConnector } from './anthropic-stub.ts';

export type DispatchedReply = {
	agentId: string;
	body: string;
};

const ECHO = (process.env.FINN_ECHO_ONLY ?? '').toLowerCase() === '1';

type MemberAgent = {
	id: string;
	name: string;
	connectorType: string;
	config: string;
};

function memberAgentsOf(channelId: string): MemberAgent[] {
	const db = getDb();
	return db
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
				eq(channelMembers.channelId, channelId),
				isNull(agents.deletedAt),
				eq(agents.enabled, true)
			)
		)
		.all();
}

function requireChannel(channelId: string): void {
	const db = getDb();
	const channel = db
		.select()
		.from(channels)
		.where(and(eq(channels.id, channelId), isNull(channels.deletedAt)))
		.get();
	if (!channel) {
		throw new Error(`unknown or deleted channel: ${channelId}`);
	}
}

async function callConnector(
	agent: MemberAgent,
	channelId: string,
	body: string
): Promise<string> {
	if (ECHO) return `echo (${agent.name}): ${body}`;

	const config = parseAgentConfig(agent.connectorType, agent.config);

	if (config.connector_type === 'openclaw') {
		return openclawConnector.send({ channelId, body, config });
	}
	if (config.connector_type === 'anthropic-stub') {
		return anthropicStubConnector.send({ channelId, body, config });
	}
	throw new Error(`unknown connector_type for agent ${agent.id}: ${agent.connectorType}`);
}

/**
 * Fan out a user message to every member agent. Returns one reply per
 * agent, in array order matching the channel-member sequence.
 *
 * Each connector call is awaited in parallel; if one fails, the others
 * still complete and the failure is reported as a per-agent error
 * surfaced to the caller.
 */
export async function dispatchUserMessage(args: {
	channel_id: string;
	body: string;
}): Promise<Array<DispatchedReply | { agentId: string; error: string }>> {
	requireChannel(args.channel_id);
	const members = memberAgentsOf(args.channel_id);
	if (members.length === 0) {
		throw new Error(`channel ${args.channel_id} has no enabled agent members`);
	}

	const results = await Promise.allSettled(
		members.map((agent) => callConnector(agent, args.channel_id, args.body))
	);

	return members.map((agent, i) => {
		const r = results[i]!;
		if (r.status === 'fulfilled') {
			return { agentId: agent.id, body: r.value };
		}
		return { agentId: agent.id, error: (r.reason as Error).message };
	});
}

/**
 * Deliver an approved message to one specific target agent. Used by
 * the approval-routing path after the user clicks Approve. The body
 * is the *original* agent message — finn does not paraphrase or
 * annotate; it relays verbatim.
 *
 * Returns the receiving agent's reply, which itself becomes a
 * regular agent message in the channel (and may trigger its own
 * approval if it mentions yet another agent).
 */
export async function dispatchToAgent(args: {
	agent_id: string;
	channel_id: string;
	body: string;
}): Promise<DispatchedReply> {
	requireChannel(args.channel_id);

	const db = getDb();
	const member = db
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
				eq(channelMembers.channelId, args.channel_id),
				eq(agents.id, args.agent_id),
				isNull(agents.deletedAt),
				eq(agents.enabled, true)
			)
		)
		.get();

	if (!member) {
		throw new Error(
			`agent ${args.agent_id} is not an enabled member of channel ${args.channel_id}`
		);
	}

	const reply = await callConnector(member, args.channel_id, args.body);
	return { agentId: member.id, body: reply };
}
