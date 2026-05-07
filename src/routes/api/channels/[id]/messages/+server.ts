/**
 * GET /api/channels/:id/messages — recent messages for a channel.
 *
 * Query params:
 *   limit:  cap on rows returned (1..1000, default 200)
 *   before: millisecond timestamp; returns messages strictly older
 *           than this. Used for 'load older' pagination at the
 *           scroll-top.
 *
 * Result is oldest-first regardless of which slice was fetched.
 */

import { json } from '@sveltejs/kit';
import { recentMessages } from '$lib/server/messages';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, url }) => {
	const limitRaw = url.searchParams.get('limit');
	const limit = limitRaw ? Math.min(Math.max(Number(limitRaw), 1), 1000) : 200;
	const beforeRaw = url.searchParams.get('before');
	const before = beforeRaw ? Number(beforeRaw) : undefined;

	const rows = recentMessages(params.id, limit, before);
	return json({ messages: rows });
};
