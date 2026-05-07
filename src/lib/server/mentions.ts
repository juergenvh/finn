/**
 * Parse `@-mentions` out of a message body and resolve them to
 * agent ids within a channel.
 *
 * Per ADR-0005: mentions are a *convenience* for pre-filling the
 * approval target picker. The user's choice in the UI is what
 * actually routes — the mention parser must therefore be permissive
 * (false positives are fine, the user will deselect them) rather
 * than strict.
 *
 * Recognised forms:
 *   @<agent.name>     — matches by agents.name (case-insensitive)
 *   @<agent_id>       — matches by agents.id (e.g. @a_8f3a2bd7e1c4)
 *
 * Unicode-letter names are supported via the \p{L} class. Trailing
 * punctuation is stripped.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from './db/client.ts';
import { agents, channelMembers } from './db/schema.ts';

const MENTION_RE = /@([\p{L}\p{N}_.\-]+)/gu;

export function extractMentions(body: string): string[] {
	const out: string[] = [];
	for (const m of body.matchAll(MENTION_RE)) {
		out.push(m[1]!);
	}
	return out;
}

/**
 * Given a message body and a channel id, return the agent ids that
 * the mentions resolve to (excluding the channel-member set is the
 * caller's job; here we only return matches that are *both* mentioned
 * AND in the channel as a non-deleted enabled agent).
 */
export function resolveMentionedAgents(channelId: string, body: string): string[] {
	const tokens = extractMentions(body);
	if (tokens.length === 0) return [];

	const db = getDb();
	const memberAgents = db
		.select({ id: agents.id, name: agents.name })
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

	const byNameLower = new Map(memberAgents.map((a) => [a.name.toLowerCase(), a.id]));
	const idSet = new Set(memberAgents.map((a) => a.id));

	const matched = new Set<string>();
	for (const t of tokens) {
		const lower = t.toLowerCase();
		if (idSet.has(t)) matched.add(t);
		else if (byNameLower.has(lower)) matched.add(byNameLower.get(lower)!);
	}
	return [...matched];
}
