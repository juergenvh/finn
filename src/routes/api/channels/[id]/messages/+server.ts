/**
 * GET /api/channels/:id/messages — recent messages for a channel.
 *
 * Returns oldest-first up to a default cap. Used by the UI to populate
 * channel history on connect.
 */

import { json } from '@sveltejs/kit';
import { recentMessages } from '$lib/server/messages';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, url }) => {
	const limitRaw = url.searchParams.get('limit');
	const limit = limitRaw ? Math.min(Math.max(Number(limitRaw), 1), 1000) : 200;
	const rows = recentMessages(params.id, limit);
	return json({ messages: rows });
};
