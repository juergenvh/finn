/**
 * GET /api/channels — list non-deleted channels.
 *
 * Read-only endpoint for the spike UI to discover the current channel
 * id. No auth (single-user local tool); see README §"Trust model".
 */

import { isNull } from 'drizzle-orm';
import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db/client';
import { channels } from '$lib/server/db/schema';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	const db = getDb();
	const rows = db
		.select({
			id: channels.id,
			name: channels.name,
			description: channels.description
		})
		.from(channels)
		.where(isNull(channels.deletedAt))
		.all();
	return json({ channels: rows });
};
