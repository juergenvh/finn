/**
 * Inflight-message read path (issue #112).
 *
 * The channel-view fetches partial bubbles via this helper. The
 * audit / protocol viewer does NOT — inflight rows are never part
 * of the audit trail; they exist only as a bridge between the
 * upstream stream and the channel UI.
 *
 * Shape returned to the client deliberately mirrors `Message`
 * enough that the bubble component does not need a separate
 * code path: same `id`, `channelId`, `senderType: 'agent'`,
 * `senderId`, `body`, `createdAt`. Extra fields (`status`,
 * `errorMessage`) carry the live-stream metadata.
 */

import { eq } from 'drizzle-orm';
import { getDb } from './db/client.ts';
import { inflightMessages, type InflightMessage } from './db/schema.ts';

/**
 * Client-facing shape. `senderType` is always `'agent'` (only
 * agents stream); we include it explicitly so the bubble
 * component can branch identically to the regular message path.
 */
export type InflightBubble = {
	id: string;
	channelId: string;
	senderType: 'agent';
	senderId: string;
	body: string;
	createdAt: number;
	status: 'streaming' | 'error';
	errorMessage: string | null;
};

function toBubble(row: InflightMessage): InflightBubble {
	return {
		id: row.id,
		channelId: row.channelId,
		senderType: 'agent',
		senderId: row.agentId,
		body: row.body,
		createdAt: row.createdAt,
		status: row.status,
		errorMessage: row.errorMessage
	};
}

/**
 * All inflight rows for a channel, ordered ascending by createdAt
 * so the client can append them to the end of the regular-message
 * slice without a re-sort.
 */
export function inflightBubblesForChannel(channelId: string): InflightBubble[] {
	const db = getDb();
	const rows = db
		.select()
		.from(inflightMessages)
		.where(eq(inflightMessages.channelId, channelId))
		.all();
	rows.sort((a, b) => a.createdAt - b.createdAt);
	return rows.map(toBubble);
}
