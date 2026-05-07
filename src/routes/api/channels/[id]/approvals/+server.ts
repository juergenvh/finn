/**
 * GET /api/channels/:id/approvals — approval rows for messages in a channel.
 *
 * Used by the UI on connect to hydrate the approval state of existing
 * messages (so a reload doesn't lose pending approvals).
 */

import { json } from '@sveltejs/kit';
import { recentMessages } from '$lib/server/messages';
import { approvalsForMessages, targetsOf } from '$lib/server/approvals';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, url }) => {
	const limitRaw = url.searchParams.get('limit');
	const limit = limitRaw ? Math.min(Math.max(Number(limitRaw), 1), 1000) : 200;
	const msgs = recentMessages(params.id, limit);
	const approvals = approvalsForMessages(msgs.map((m) => m.id)).map((a) => ({
		...a,
		targets: targetsOf(a)
	}));
	return json({ approvals });
};
