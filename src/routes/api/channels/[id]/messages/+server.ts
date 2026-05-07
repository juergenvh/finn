/**
 * GET /api/channels/:id/messages
 *
 * Three modes:
 *
 *   ?limit=N                Most recent N messages (default mode).
 *   ?limit=N&before=<ms>    Page of N messages older than `before`.
 *                           Used by the 'load older' pagination button.
 *   ?budget=KB              Recent messages capped on cumulative body
 *                           size in kilobytes. Used by the initial
 *                           channel-view load (issue #13). Reply
 *                           includes `has_more: boolean` so the UI
 *                           knows whether 'load older' makes sense.
 *
 * `budget` and `before` are mutually exclusive; if both are given,
 * `before` wins (paginating older history is a deliberate user
 * action).
 *
 * Result is always oldest-first.
 */

import { json } from '@sveltejs/kit';
import { recentMessages, recentMessagesByBudget } from '$lib/server/messages';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, url }) => {
	const limitRaw = url.searchParams.get('limit');
	const beforeRaw = url.searchParams.get('before');
	const budgetRaw = url.searchParams.get('budget');

	const limit = limitRaw ? Math.min(Math.max(Number(limitRaw), 1), 1000) : 200;
	const before = beforeRaw ? Number(beforeRaw) : undefined;

	if (budgetRaw && !before) {
		const budgetKb = Math.min(Math.max(Number(budgetRaw), 1), 4096);
		const { rows, hasMore } = recentMessagesByBudget(params.id, budgetKb * 1024);
		return json({ messages: rows, has_more: hasMore });
	}

	const rows = recentMessages(params.id, limit, before);
	return json({ messages: rows });
};
