/**
 * GET /api/protocol/export — markdown export of a cross-channel
 * protocol query (issue #14).
 *
 * Same query parameters as /api/protocol; rather than paginating, this
 * endpoint walks until it has collected all matching rows (capped at a
 * sanity limit to avoid pathological exports), renders them via
 * exportProtocolMarkdown, and returns the file as
 * `Content-Disposition: attachment`.
 */

import { error } from '@sveltejs/kit';
import { queryProtocol, type ProtocolQuery, type VisibilityFilter } from '$lib/server/protocol';
import { exportProtocolMarkdown } from '$lib/server/export-channel';
import type { RequestHandler } from './$types';

const HARD_EXPORT_LIMIT = 50_000;

function parseList(v: string | null): string[] {
	if (!v) return [];
	return v.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

function parseSenderTypes(v: string | null): Array<'user' | 'agent' | 'system'> {
	const items = parseList(v);
	const out: Array<'user' | 'agent' | 'system'> = [];
	for (const t of items) {
		if (t === 'user' || t === 'agent' || t === 'system') out.push(t);
	}
	return out;
}

function parseVisibility(v: string | null): VisibilityFilter {
	if (v === 'visible_only' || v === 'hidden_only' || v === 'all') return v;
	return 'all';
}

function parseNumber(v: string | null): number | undefined {
	if (!v) return undefined;
	const n = Number(v);
	return Number.isFinite(n) ? n : undefined;
}

export const GET: RequestHandler = async ({ url }) => {
	const format = url.searchParams.get('format') ?? 'md';
	if (format !== 'md') throw error(400, `unsupported export format: ${format}`);

	const baseQuery: ProtocolQuery = {
		channelIds: parseList(url.searchParams.get('channels')),
		q: url.searchParams.get('q') ?? undefined,
		senderTypes: parseSenderTypes(url.searchParams.get('sender_types')),
		senderAgentIds: parseList(url.searchParams.get('senders')),
		from: parseNumber(url.searchParams.get('from')),
		to: parseNumber(url.searchParams.get('to')),
		visibility: parseVisibility(url.searchParams.get('visibility')),
		onlyRejected: url.searchParams.get('only_rejected') === '1',
		limit: 1000
	};

	// Walk pages until exhausted. The protocol viewer is the audit
	// surface; users will sometimes want to export a long timespan in
	// one click. The hard cap is a safeguard, not an expected bound.
	const all = [];
	let cursor: string | null = null;
	while (all.length < HARD_EXPORT_LIMIT) {
		const page = queryProtocol({ ...baseQuery, cursor: cursor ?? undefined });
		all.push(...page.rows);
		if (!page.nextCursor) break;
		cursor = page.nextCursor;
	}

	// queryProtocol returns DESC order. Reverse for chronological export.
	all.reverse();

	// Build a small filter-summary block for the header.
	const filterSummary: string[] = [];
	if (baseQuery.channelIds && baseQuery.channelIds.length > 0)
		filterSummary.push(`channels: ${baseQuery.channelIds.join(', ')}`);
	if (baseQuery.q) filterSummary.push(`search: "${baseQuery.q}"`);
	if (baseQuery.senderTypes && baseQuery.senderTypes.length > 0 && baseQuery.senderTypes.length < 3)
		filterSummary.push(`sender types: ${baseQuery.senderTypes.join(', ')}`);
	if (baseQuery.senderAgentIds && baseQuery.senderAgentIds.length > 0)
		filterSummary.push(`agent senders: ${baseQuery.senderAgentIds.join(', ')}`);
	if (baseQuery.from !== undefined)
		filterSummary.push(`from: ${new Date(baseQuery.from).toISOString()}`);
	if (baseQuery.to !== undefined)
		filterSummary.push(`to: ${new Date(baseQuery.to).toISOString()}`);
	if (baseQuery.visibility && baseQuery.visibility !== 'all')
		filterSummary.push(`visibility: ${baseQuery.visibility}`);
	if (baseQuery.onlyRejected) filterSummary.push('only rejected approvals');

	const exported = exportProtocolMarkdown({ rows: all, filterSummary });

	return new Response(exported.body, {
		headers: {
			'content-type': 'text/markdown; charset=utf-8',
			'content-disposition': `attachment; filename="${exported.filename}"`
		}
	});
};
