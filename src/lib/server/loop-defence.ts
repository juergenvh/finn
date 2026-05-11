/**
 * Per-channel agent-to-agent roundtrip cap (ADR-0020).
 *
 * In-memory counter; one Map keyed by channel id. The counter
 * increments on every agent-to-agent dispatch (approval-decide
 * relay or future auto-approve path) and resets on every
 * persisted user message in the channel.
 *
 * Server restart wipes the state — that is acceptable per
 * ADR-0020 §Counter semantics, because a restart equally wipes
 * any active loop and the next user message would reset the
 * counter anyway.
 *
 * The cap value itself comes from the settings surface
 * (ADR-0019 columns `roundtrip_cap_default` / `_override`); this
 * module reads it via `readRoundtripCap`.
 */

import { eq } from 'drizzle-orm';
import { getDb } from './db/client.ts';
import { settingsGlobal, settingsChannel } from './db/schema.ts';

/** Hardcoded fallback when the DB has no settings row at all. Matches
 * the column default in `settings_global` so a missing row degrades
 * to identical behaviour. */
export const ROUNDTRIP_CAP_FALLBACK = 5;

const counters = new Map<string, number>();

/**
 * Read the effective roundtrip cap for a channel:
 * channel override → global default → hardcoded fallback.
 *
 * Called from the dispatch path, so it must be fast and
 * defensive: if the DB read fails, return the fallback rather
 * than throwing into the middle of a stream.
 */
export function readRoundtripCap(channelId: string): number {
	try {
		const db = getDb();
		const override = db
			.select({ value: settingsChannel.roundtripCapOverride })
			.from(settingsChannel)
			.where(eq(settingsChannel.channelId, channelId))
			.get();
		if (override?.value != null) return override.value;

		const global = db
			.select({ value: settingsGlobal.roundtripCapDefault })
			.from(settingsGlobal)
			.where(eq(settingsGlobal.id, 1))
			.get();
		if (global?.value != null) return global.value;
	} catch {
		// fall through to fallback
	}
	return ROUNDTRIP_CAP_FALLBACK;
}

/**
 * Attempt to consume one roundtrip slot for `channelId`.
 *
 * Returns `{ allowed: true, used, cap }` when the dispatch may
 * proceed; the counter has been incremented.
 *
 * Returns `{ allowed: false, used, cap }` when the cap has been
 * reached; the caller MUST NOT dispatch and SHOULD emit a
 * system message naming `cap` and the reset rule.
 */
export function tryConsumeRoundtrip(
	channelId: string
): { allowed: true; used: number; cap: number } | { allowed: false; used: number; cap: number } {
	const cap = readRoundtripCap(channelId);
	const used = counters.get(channelId) ?? 0;
	if (used >= cap) {
		return { allowed: false, used, cap };
	}
	counters.set(channelId, used + 1);
	return { allowed: true, used: used + 1, cap };
}

/**
 * Reset the per-channel roundtrip counter. Called from
 * `recordUserMessage` so a user typing into the channel always
 * gives the loop defence a fresh window.
 */
export function resetRoundtrips(channelId: string): void {
	counters.delete(channelId);
}

/**
 * Test-only helper: read the current counter without consuming
 * a slot. Not exported via the public surface; lives here for
 * the acceptance script.
 */
export function _peekRoundtripCounter(channelId: string): number {
	return counters.get(channelId) ?? 0;
}
