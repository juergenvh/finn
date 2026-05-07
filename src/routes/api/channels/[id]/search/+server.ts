/**
 * GET /api/channels/:id/search?q=<term>&limit=<n>
 *
 * Substring search within one channel's message bodies.
 *
 * v1: plain LIKE, case-insensitive for ASCII. Cross-channel search
 * and FTS5 are tracked as follow-ups under issue #2.
 */

import { json, error } from '@sveltejs/kit';
import { searchMessages } from '$lib/server/messages';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, url }) => {
	const q = url.searchParams.get('q');
	if (!q || q.trim().length === 0) throw error(400, 'q (query) required');

	const limitRaw = url.searchParams.get('limit');
	const limit = limitRaw ? Math.min(Math.max(Number(limitRaw), 1), 500) : 100;

	const rows = searchMessages(params.id, q, limit);
	return json({ messages: rows });
};
