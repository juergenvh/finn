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
 * Visibility: groomed (hidden_at != NULL) messages are **included**
 * in the response (issue #34). The channel-view UI applies the
 * 'show groomed' toggle client-side; the server fetch always
 * returns the full slice so toggling does not require a refetch.
 * The protocol viewer (audit surface) reads through a different
 * path (src/lib/server/protocol.ts) and is unaffected.
 *
 * Result is always oldest-first.
 */

import { json } from '@sveltejs/kit';
import { recentMessages, recentMessagesByBudget } from '$lib/server/messages';
import { inflightBubblesForChannel } from '$lib/server/inflight-read';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, url }) => {
	const limitRaw = url.searchParams.get('limit');
	const beforeRaw = url.searchParams.get('before');
	const budgetRaw = url.searchParams.get('budget');

	const limit = limitRaw ? Math.min(Math.max(Number(limitRaw), 1), 1000) : 200;
	const before = beforeRaw ? Number(beforeRaw) : undefined;

	// Inflight bubbles ride along on the *initial* channel fetch only:
	// when the user paginates older history (`before` is set), they
	// don't belong there — inflight rows by definition live at the
	// tail. The bubbles' shape is documented in inflight-read.ts and
	// mirrors the `Message` rows enough that the channel-view can
	// render them through the same component (issue #112).
	const inflight = before ? [] : inflightBubblesForChannel(params.id);

	if (budgetRaw && !before) {
		const budgetKb = Math.min(Math.max(Number(budgetRaw), 1), 4096);
		const { rows, hasMore } = recentMessagesByBudget(
			params.id,
			budgetKb * 1024,
			'all'
		);
		return json({ messages: rows, has_more: hasMore, inflight });
	}

	const rows = recentMessages(params.id, limit, before, 'all');
	return json({ messages: rows, inflight });
};
