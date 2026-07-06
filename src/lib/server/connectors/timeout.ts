/**
 * Shared timeout for connector HTTP calls.
 *
 * Without this, a backend that accepts the connection but never responds
 * — or stalls mid-stream without closing — leaves the per-agent stream
 * promise pending forever. That wedges every `Promise.all` fan-out that
 * awaits it (approval-decide, forward) and the roundtrip cap slot it
 * holds, with no recovery short of a process restart. See issue #193.
 *
 * This is an *idle* timeout, not a fixed total-duration cap: the clock
 * resets on connect and on every chunk received, so it only fires when
 * nothing has happened for the full window — not when a slow-but-healthy
 * backend is still working. This matters concretely for OpenClaw agents
 * that do multi-step tool use (read files, run searches, propose patches)
 * before ever emitting their first token: that time-to-first-byte can
 * legitimately run into several minutes even though the connection is
 * fine. A fixed 120s cap (the original value here) reported "stream
 * failed: timeout" on those while the underlying task kept running to
 * completion server-side — a false positive, not the hung-forever case
 * this timeout exists to catch.
 *
 * Overridable via FINN_CONNECTOR_TIMEOUT_MS for backends that are
 * legitimately slower still.
 */
const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes

export function connectorTimeoutMs(): number {
	const raw = process.env.FINN_CONNECTOR_TIMEOUT_MS;
	const parsed = raw ? Number(raw) : NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

/**
 * An AbortController whose abort fires only after `timeoutMs` of silence.
 * Call `touch()` on connect (headers received) and on every chunk read
 * from the response body; call `clear()` once the stream is done (success
 * or error) to release the pending timer.
 */
export type IdleAbort = {
	controller: AbortController;
	touch: () => void;
	clear: () => void;
};

export function createIdleAbort(timeoutMs: number): IdleAbort {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | null = null;

	const arm = () => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			controller.abort(new DOMException(`No data received for ${timeoutMs}ms`, 'TimeoutError'));
		}, timeoutMs);
		// Don't let a pending idle timer keep the process alive on its own
		// (e.g. during shutdown) — it's cleared normally on stream end.
		timer.unref?.();
	};

	arm();

	return {
		controller,
		touch: arm,
		clear: () => {
			if (timer) clearTimeout(timer);
			timer = null;
		}
	};
}
