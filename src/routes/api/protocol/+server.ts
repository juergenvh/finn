/**
 * GET /api/protocol — cross-channel audit query (issue #14).
 *
 * Query parameters (all optional):
 *
 *   channels=<id>,<id>,...    Restrict to these channels.
 *   q=<term>                  Substring search in body.
 *   sender_types=user,agent,system   Restrict to these sender types.
 *   senders=<agentId>,<agentId>,...  Restrict to these agents (when
 *                              the row's sender_type is 'agent').
 *   from=<ms>                 Inclusive lower bound on created_at.
 *   to=<ms>                   Inclusive upper bound on created_at.
 *   visibility=visible_only|hidden_only|all   Default 'all'.
 *   only_rejected=1           Only messages with status=rejected.
 *   cursor=<opaque>           Pagination cursor from previous reply.
 *   limit=<n>                 1..1000, default 200.
 *
 * The protocol viewer ignores grooming visibility by default
 * (per ADR-0004 the audit log shows everything), but `visibility=`
 * lets the user narrow if they want.
 */

import { json } from '@sveltejs/kit';
import { queryProtocol, type ProtocolQuery, type VisibilityFilter } from '$lib/server/protocol';
import type { RequestHandler } from './$types';

function parseList(value: string | null): string[] {
	if (!value) return [];
	return value
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

function parseSenderTypes(value: string | null): Array<'user' | 'agent' | 'system'> {
	const items = parseList(value);
	const valid: Array<'user' | 'agent' | 'system'> = [];
	for (const t of items) {
		if (t === 'user' || t === 'agent' || t === 'system') valid.push(t);
	}
	return valid;
}

function parseVisibility(value: string | null): VisibilityFilter {
	if (value === 'visible_only' || value === 'hidden_only' || value === 'all') return value;
	return 'all';
}

function parseNumber(value: string | null): number | undefined {
	if (!value) return undefined;
	const n = Number(value);
	return Number.isFinite(n) ? n : undefined;
}

export const GET: RequestHandler = async ({ url }) => {
	const q: ProtocolQuery = {
		channelIds: parseList(url.searchParams.get('channels')),
		q: url.searchParams.get('q') ?? undefined,
		senderTypes: parseSenderTypes(url.searchParams.get('sender_types')),
		senderAgentIds: parseList(url.searchParams.get('senders')),
		from: parseNumber(url.searchParams.get('from')),
		to: parseNumber(url.searchParams.get('to')),
		visibility: parseVisibility(url.searchParams.get('visibility')),
		onlyRejected: url.searchParams.get('only_rejected') === '1',
		cursor: url.searchParams.get('cursor') ?? undefined,
		limit: parseNumber(url.searchParams.get('limit'))
	};

	const page = queryProtocol(q);
	return json({ rows: page.rows, next_cursor: page.nextCursor });
};
