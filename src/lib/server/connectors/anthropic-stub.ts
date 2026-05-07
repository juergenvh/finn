/**
 * Anthropic stub connector.
 *
 * For development and testing only — does NOT call the real Anthropic
 * API. Returns canned responses so we can exercise the multi-agent
 * flow (approval state machine, mention parsing, target picking)
 * without burning API credits or needing a real key.
 *
 * Switch to a real implementation by replacing this file with a
 * connector that calls https://api.anthropic.com/v1/messages.
 * The dispatch contract (see registry.ts) stays the same.
 */

import type { z } from 'zod';

// Mirror the OpenclawConfig shape pattern, but minimal.
import { z as zod } from 'zod';

export const AnthropicStubConfigSchema = zod.object({
	connector_type: zod.literal('anthropic-stub'),
	persona: zod.string().min(1).default('a generic assistant'),
	/** Canned reply patterns. Picked round-robin per channel. */
	replies: zod.array(zod.string().min(1)).min(1)
});

export type AnthropicStubConfig = z.infer<typeof AnthropicStubConfigSchema>;

export type AnthropicStubSendArgs = {
	channelId: string;
	body: string;
	config: AnthropicStubConfig;
};

const counters = new Map<string, number>();

async function send(args: AnthropicStubSendArgs): Promise<string> {
	const key = `${args.channelId}|${args.config.persona}`;
	const idx = counters.get(key) ?? 0;
	counters.set(key, idx + 1);
	const reply = args.config.replies[idx % args.config.replies.length]!;
	// Tiny artificial latency so the UI gets to render the user
	// message before the reply lands; keeps the stream feeling real.
	await new Promise((r) => setTimeout(r, 80));
	return reply;
}

export const anthropicStubConnector = { send };
