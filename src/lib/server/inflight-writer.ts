/**
 * In-flight bubble checkpointing (issue #112).
 *
 * Mirrors a running agent stream into the `inflight_messages`
 * table so that a client reconnecting (page reload, focus-back
 * after the OS suspended the tab, returning from a new-tab link
 * click that bypassed PR #111, …) sees the partial body that has
 * arrived so far, plus a `streaming` / `error` status.
 *
 * Why a separate writer, not inline DB calls inside
 * `streamOneAgent`:
 *
 *   - Throttling. We do not want one write per delta — a 2000-token
 *     reply at ~10 tokens/delta would be 200 writes. We coalesce by
 *     **time only**: every flush queues the next flush ~500 ms
 *     later, so a stream that emits a delta every 20 ms produces
 *     ~2 writes per second, and a stream that idles between tool
 *     calls produces nothing until the next delta. Token-count is
 *     not in the throttle decision because the budget that matters
 *     is wall-clock recovery (the user comes back at human speed),
 *     not delta count.
 *
 *   - State machine. The writer owns the row's lifecycle:
 *     `start()` inserts at body=''; `appendDelta()` updates the
 *     buffer; `finalizeOk()` deletes the row (the final body goes
 *     to `messages` via the existing recordAgentMessage path);
 *     `finalizeError()` updates the row to `status='error'` so
 *     the client sees what happened on the next channel-fetch
 *     before the server deletes the row.
 *
 *   - Test surface. The writer exposes its `flushNow()` so unit
 *     tests can drive deterministic flushes instead of waiting on
 *     real timers.
 *
 * Lifetime contract:
 *
 *   const w = new InflightWriter(messageId, channelId, agentId, startedAt);
 *   w.start();              // synchronous DB insert
 *   for await (delta) w.appendDelta(text);   // buffered + throttled
 *   await w.finalizeOk();   // synchronous DB delete
 *   // (or)
 *   await w.finalizeError("...");  // synchronous DB update
 *
 * The writer is single-stream-scoped. Every running agent reply
 * gets its own writer. `streamOneAgent` is the only caller.
 */

import { eq } from 'drizzle-orm';
import { getDb } from './db/client.ts';
import { inflightMessages } from './db/schema.ts';

const DEFAULT_FLUSH_MS = 500;

export interface InflightWriterOptions {
	/** Override the flush throttle. Used by tests; production
	 * keeps the default. */
	flushMs?: number;
	/** Inject a clock for deterministic tests. Defaults to
	 * `Date.now`. */
	now?: () => number;
}

export class InflightWriter {
	private buffer = '';
	private pendingFlush = false;
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private finalised = false;
	private dirty = false;
	private readonly flushMs: number;
	private readonly nowFn: () => number;

	constructor(
		readonly messageId: string,
		readonly channelId: string,
		readonly agentId: string,
		readonly startedAt: number,
		opts: InflightWriterOptions = {}
	) {
		this.flushMs = opts.flushMs ?? DEFAULT_FLUSH_MS;
		this.nowFn = opts.now ?? (() => Date.now());
	}

	/**
	 * Insert the initial empty row. Synchronous so that an immediate
	 * client-reconnect can see the row even if no delta has arrived
	 * yet — the bubble shows as "streaming, empty so far" rather
	 * than disappearing on the user.
	 */
	start(): void {
		const db = getDb();
		const ts = this.nowFn();
		db.insert(inflightMessages)
			.values({
				id: this.messageId,
				channelId: this.channelId,
				agentId: this.agentId,
				body: '',
				status: 'streaming',
				errorMessage: null,
				createdAt: this.startedAt,
				updatedAt: ts
			})
			.run();
	}

	/**
	 * Append delta text to the in-memory buffer and schedule a
	 * flush. If a flush is already pending, this is a no-op except
	 * for the buffer update — the in-flight timer will pick up the
	 * new content when it fires.
	 *
	 * Throttling is **debounce-after-fire**, not classic debounce:
	 * the first delta triggers a flush ~500 ms later; further
	 * deltas during that window are bundled into the same flush;
	 * after the flush completes, the next delta restarts the
	 * 500 ms window. This keeps idle gaps (model thinking, tool
	 * loop) cheap — they cost zero writes.
	 */
	appendDelta(text: string): void {
		if (this.finalised) return;
		this.buffer += text;
		this.dirty = true;
		this.scheduleFlush();
	}

	private scheduleFlush(): void {
		if (this.pendingFlush || this.finalised) return;
		this.pendingFlush = true;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			this.pendingFlush = false;
			// Catch errors from flushNow so a transient DB problem
			// does not kill the streaming loop. The client will see
			// the stale body until the next flush succeeds — better
			// than the stream dying mid-reply.
			try {
				this.flushNow();
			} catch (err) {
				console.error(
					`[inflight-writer] flush failed for ${this.messageId}: ${(err as Error).message}`
				);
			}
		}, this.flushMs);
	}

	/**
	 * Force-write the current buffer to the row, regardless of the
	 * timer. Useful in tests and on graceful shutdown.
	 */
	flushNow(): void {
		if (this.finalised || !this.dirty) return;
		const db = getDb();
		db.update(inflightMessages)
			.set({ body: this.buffer, updatedAt: this.nowFn() })
			.where(eq(inflightMessages.id, this.messageId))
			.run();
		this.dirty = false;
	}

	/**
	 * Stream finished cleanly. The final body has been (or is being)
	 * written to `messages` by the caller; we drop the inflight row.
	 *
	 * Cancels any pending throttled flush so we don't write a row
	 * we're about to delete.
	 */
	finalizeOk(): void {
		if (this.finalised) return;
		this.finalised = true;
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
			this.pendingFlush = false;
		}
		const db = getDb();
		db.delete(inflightMessages).where(eq(inflightMessages.id, this.messageId)).run();
	}

	/**
	 * Stream failed mid-flight. Persist the partial body plus the
	 * error string so a reconnecting client sees what happened. The
	 * row sticks around — a separate sweep (`reapInflightAfterDelay`)
	 * deletes it after the next channel-fetch has had a chance to
	 * surface it. Not implemented in this slice; for now the row
	 * lives until the next server restart.
	 *
	 * In practice the upstream `streamOneAgent` will also append an
	 * `[error: …]` line into a real `messages` row via the existing
	 * error path, so the error is durably recorded; this inflight
	 * row is just the bridge for the reconnecting client.
	 */
	finalizeError(errorMessage: string): void {
		if (this.finalised) return;
		this.finalised = true;
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
			this.pendingFlush = false;
		}
		// Final flush of whatever was in the buffer, then mark error.
		const db = getDb();
		db.update(inflightMessages)
			.set({
				body: this.buffer,
				status: 'error',
				errorMessage,
				updatedAt: this.nowFn()
			})
			.where(eq(inflightMessages.id, this.messageId))
			.run();
	}
}

/**
 * Startup sweep — call once when the server boots, before
 * accepting any client connections. Any row left in
 * `inflight_messages` from a previous process is by definition
 * orphaned (its stream-loop is gone), so we mark it as
 * `interrupted_by_restart` so a client that returns to a channel
 * with such a row sees the error explicitly instead of an
 * eternally-streaming bubble.
 *
 * A follow-up cleanup pass deletes those error rows after their
 * first channel-fetch is observed; for the first slice we just
 * leave them in place — single-user MVP, low row count.
 */
export function sweepStaleInflightOnBoot(): void {
	const db = getDb();
	db.update(inflightMessages)
		.set({
			status: 'error',
			errorMessage: 'interrupted_by_restart',
			updatedAt: Date.now()
		})
		.where(eq(inflightMessages.status, 'streaming'))
		.run();
}
