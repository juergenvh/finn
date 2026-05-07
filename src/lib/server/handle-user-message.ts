/**
 * Default user-message hook implementation.
 *
 * 1. Persist the user turn via messages.ts.
 * 2. Dispatch to the channel's agent via connectors/registry.ts.
 * 3. Persist the agent reply (if any).
 * 4. Return broadcast payloads to attach.ts.
 *
 * Both the dev plugin (vite) and the production server use this exact
 * function, so behaviour stays identical across environments.
 */

import type { UserMessageResult } from './ws/attach.ts';
import { recordUserMessage, recordAgentMessage } from './messages.ts';
import { dispatchUserMessage } from './connectors/registry.ts';
import { agentForChannel } from './channel-agent.ts';

export async function handleUserMessage(args: {
	channel_id: string;
	body: string;
}): Promise<UserMessageResult> {
	const userRow = recordUserMessage({ channelId: args.channel_id, body: args.body });

	const result: UserMessageResult = {
		user: {
			type: 'message',
			channel_id: userRow.channelId,
			sender: 'user',
			body: userRow.body,
			ts: userRow.createdAt,
			id: userRow.id
		}
	};

	const replyBody = await dispatchUserMessage({ channel_id: args.channel_id, body: args.body });
	if (replyBody === null || replyBody === undefined) {
		return result;
	}

	// We need to attribute the reply to the right agent. Channels have
	// exactly one member agent in the spike (the registry enforces this).
	const agentId = agentForChannel(args.channel_id);

	const agentRow = recordAgentMessage({
		channelId: args.channel_id,
		body: replyBody,
		agentId
	});

	result.agent = {
		type: 'message',
		channel_id: agentRow.channelId,
		sender: 'agent',
		body: agentRow.body,
		ts: agentRow.createdAt,
		id: agentRow.id
	};
	return result;
}
