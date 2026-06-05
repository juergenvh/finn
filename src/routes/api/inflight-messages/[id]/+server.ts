/**
 * DELETE /api/inflight-messages/:id
 *
 * Removes a single row from inflight_messages. Used by the client
 * to dismiss inflight/error bubbles via the X button (bug #118).
 *
 * Inflight messages are not regular messages — they live in a
 * separate table and cannot be groomed via PATCH /api/messages/:id/visibility,
 * which only touches the messages table. Attempting to do so returns 404.
 *
 * Returns 200 { ok: true } on success, 404 if the row does not exist.
 * Does not broadcast a state_changed event: the caller removes the bubble
 * from the in-memory list immediately for snappy UX, and other tabs will
 * naturally drop the bubble on their next channel load (the row is gone).
 */

import { json, error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { inflightMessages } from '$lib/server/db/schema';

export async function DELETE({ params }: { params: { id: string } }) {
	const db = getDb();
	const { id } = params;

	const existing = db
		.select({ id: inflightMessages.id })
		.from(inflightMessages)
		.where(eq(inflightMessages.id, id))
		.get();

	if (!existing) {
		error(404, `Inflight message not found: ${id}`);
	}

	db.delete(inflightMessages).where(eq(inflightMessages.id, id)).run();

	return json({ ok: true });
}
