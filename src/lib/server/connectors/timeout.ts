/**
 * Shared timeout for connector HTTP calls (connect through end of the SSE
 * stream, since Node's fetch ties the AbortSignal to the whole request —
 * an abort after headers arrive still errors out an in-flight body read).
 *
 * Without this, a backend that accepts the connection but never responds
 * — or stalls mid-stream without closing — leaves the per-agent stream
 * promise pending forever. That wedges every `Promise.all` fan-out that
 * awaits it (approval-decide, forward) and the roundtrip cap slot it
 * holds, with no recovery short of a process restart. See issue #193.
 *
 * Overridable via FINN_CONNECTOR_TIMEOUT_MS for backends that are
 * legitimately slower than the default.
 */
const DEFAULT_TIMEOUT_MS = 120_000;

export function connectorTimeoutMs(): number {
	const raw = process.env.FINN_CONNECTOR_TIMEOUT_MS;
	const parsed = raw ? Number(raw) : NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}
