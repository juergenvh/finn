/**
 * Server-internal readers for effective per-channel settings.
 *
 * The HTTP `/api/settings?channelId=...` handler returns the same
 * effective values, but the dispatch path (handle-user-message.ts,
 * handle-approval-decide.ts) cannot afford a network round-trip to
 * its own API, and we don't want to share state-shape with a
 * fetch-and-parse path either.
 *
 * Precedence is identical to the HTTP path:
 *   channel override → global default → hardcoded fallback.
 *
 * Defensive: a failed DB read returns the fallback rather than
 * throwing, since these are called from streaming hot paths where
 * an unhandled throw would surface as `dispatch error` to the user.
 *
 * Roundtrip-cap reads live in `loop-defence.ts` for historical
 * reasons (ADR-0020 shipped first); this module covers the
 * boolean toggles and may absorb the cap reader later if the
 * split feels arbitrary.
 */

import { eq } from 'drizzle-orm';
import { getDb } from './db/client.ts';
import { settingsChannel } from './db/schema.ts';

/**
 * Read the effective `auto_approve` flag for a channel.
 *
 * Channels with no `settings_channel` row inherit `false` — the
 * global-settings table does not carry a default for this key
 * (the design choice, ADR-0015 §1, is that auto-approve is
 * always an explicit per-channel opt-in, never a global default).
 *
 * On DB error, returns `false` so the fail-closed behaviour
 * keeps the human in the loop. A spurious approval gate is a
 * minor annoyance; a spurious bypass would be a safety regression.
 */
export function readAutoApprove(channelId: string): boolean {
	try {
		const db = getDb();
		const row = db
			.select({ value: settingsChannel.autoApprove })
			.from(settingsChannel)
			.where(eq(settingsChannel.channelId, channelId))
			.get();
		return row?.value === true;
	} catch {
		return false;
	}
}
