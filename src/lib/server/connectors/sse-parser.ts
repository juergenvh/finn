/**
 * Minimal SSE (Server-Sent Events) parser for OpenAI-shaped streams.
 *
 * Both the OpenClaw gateway's `/v1/chat/completions` and the
 * Wintermute `/v1/chat/completions` adapter (and any other
 * OpenAI-compatible backend with `stream: true`) deliver responses
 * as a sequence of `data: {json}\n\n` frames terminated by
 * `data: [DONE]`. This module parses those frames and yields a
 * discriminated union (— see `SseEvent`) of content deltas and
 * the optional final `usage` block, hiding all wire-format
 * gymnastics from the caller.
 *
 * Why not pull in `eventsource-parser` or similar:
 *   - Our needs are exactly two: split on the SSE frame boundary
 *     (blank line) and pluck `choices[0].delta.content`. Both fit
 *     in ~30 lines of code.
 *   - Streaming-parser libraries assume browser EventSource with
 *     reconnection, last-event-id, named events. We have none of
 *     those; we just consume one fetch body once.
 *   - One fewer dependency to keep CVE-watching.
 *
 * The parser handles:
 *   - Frames split arbitrarily across HTTP chunks (the network
 *     gives us bytes when it gives them, frame boundaries are
 *     not aligned to chunk boundaries).
 *   - `data: [DONE]` as a clean end-of-stream marker.
 *   - The `finish_reason: "error"` frame our Wintermute adapter
 *     can emit on mid-stream failure (PR #40 of the wintermute
 *     repo, see docs/OPENAI-COMPAT.md). When seen, the parser
 *     yields the error content and throws so the caller surfaces
 *     a `message_error` rather than a clean end.
 *   - Streams that terminate without a `[DONE]` marker (network
 *     drop, server crash). If at least one content delta was
 *     yielded, we treat that as a quiet end-of-stream; if zero,
 *     we throw so the caller can emit `message_error`.
 *
 * The parser is intentionally lenient about content shape:
 *   - Frames whose JSON is malformed are *skipped* (warned via
 *     console), not fatal. A single corrupt frame in the middle
 *     of an otherwise-good stream should not fail the whole
 *     reply.
 *   - Frames missing `choices[0].delta.content` are skipped. Some
 *     OpenAI-compatible backends emit role-only opener frames
 *     (`{"delta": {"role": "assistant"}}`) and finish-marker
 *     frames (`{"delta": {}, "finish_reason": "stop"}`); both
 *     are silently absorbed.
 */

const SSE_DONE = '[DONE]';

/**
 * Token usage block reported by the upstream stream.
 *
 * Mirrors OpenAI's `chat.completion.chunk.usage` shape (and
 * Anthropic's, when passed through OpenClaw): all three counters
 * are non-negative integers. Backends that omit usage simply
 * never emit a `usage`-bearing frame, and the parser never
 * yields a `{ kind: 'usage' }` event for that stream.
 */
export type UsageReport = {
	input: number;
	output: number;
	total: number;
};

/**
 * Discriminated union yielded by `parseSseStream`.
 *
 * - `delta`: one content fragment, append-to-body verbatim. The
 *   stream may emit zero or more of these.
 * - `usage`: the upstream's final token-usage block. Emitted at
 *   most once per stream, and only by backends that surface
 *   usage on their SSE wire (OpenClaw → Anthropic / Ollama; not
 *   Wintermute today). Order with respect to `delta` events is
 *   not guaranteed — typically it arrives in the last frame
 *   before `[DONE]`, but the parser does not enforce that.
 */
export type SseEvent =
	| { kind: 'delta'; text: string }
	| { kind: 'usage'; usage: UsageReport };

type OpenAIStreamFrame = {
	choices?: Array<{
		delta?: { role?: string; content?: string };
		finish_reason?: string | null;
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
	};
};

/**
 * Consume an SSE-shaped `Response.body` and yield the content
 * delta strings as they arrive.
 *
 * Throws on:
 *   - The `finish_reason: "error"` frame Wintermute emits on
 *     mid-stream failure (the error message is included).
 *   - End of stream with zero deltas yielded (likely server
 *     never produced content; surfaces as `message_error` at
 *     the dispatcher level).
 *
 * Does **not** throw on network drops mid-stream once at least
 * one delta has been seen. Callers that need stricter behaviour
 * (e.g. detecting silent truncation) should look at the
 * `[DONE]` sentinel via the boolean return below.
 */
export async function* parseSseStream(
	body: ReadableStream<Uint8Array> | null
): AsyncGenerator<SseEvent, void, void> {
	if (!body) {
		throw new Error('streaming response had no body');
	}

	const reader = body.getReader();
	const decoder = new TextDecoder('utf-8');
	let buffer = '';
	let yieldedAnyDelta = false;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			// Frames are separated by a blank line, i.e. `\n\n`.
			// CRLF servers exist (`\r\n\r\n`); we normalise.
			let boundary: number;
			while ((boundary = findFrameBoundary(buffer)) !== -1) {
				const frameRaw = buffer.slice(0, boundary);
				// Skip past the boundary itself (length depends on
				// CRLF vs LF; findFrameBoundary returns the index
				// of the boundary's first byte, plus the consumed
				// length).
				buffer = buffer.slice(boundary + frameLen(buffer, boundary));

				const outcome = yield* processFrame(frameRaw);
				if (outcome === 'done') {
					// Drain any remaining buffer; further frames
					// after [DONE] are non-conformant and ignored.
					return;
				}
				if (outcome === 'delta') yieldedAnyDelta = true;
			}
		}

		// Stream ended without a `[DONE]` sentinel. Two cases:
		//   - The server cleanly closed after content — common for
		//     non-OpenAI strict backends. Treat as end-of-stream.
		//   - The server closed without ever sending content. Fail
		//     the call so the caller can emit `message_error`.
		// Flush whatever's left in `buffer` first in case the last
		// frame had no trailing blank line.
		if (buffer.trim().length > 0) {
			const outcome = yield* processFrame(buffer);
			if (outcome === 'delta') yieldedAnyDelta = true;
		}
		if (!yieldedAnyDelta) {
			throw new Error('streaming response ended without producing content');
		}
		// else: silent end-of-stream is acceptable.
	} finally {
		reader.releaseLock();
	}
}

/**
 * Process one raw SSE frame. Yields zero or more `SseEvent`s.
 *
 * Returns:
 *   - `'done'`    when the frame is `data: [DONE]`. Caller
 *                 should stop reading.
 *   - `'delta'`   when a content delta was yielded.
 *   - `'usage'`   when only a usage block was yielded (no
 *                 content delta in this frame).
 *   - `'skipped'` when the frame had nothing yieldable
 *                 (role-opener, finish-marker without content,
 *                 malformed JSON, comment, blank).
 *
 * Throws when the frame carries `finish_reason: "error"` so the
 * caller surfaces a `message_error` rather than a quiet stop.
 *
 * A single frame can carry both a content delta and a usage
 * block (some backends pack the final token's content + usage
 * into one frame). Both are yielded; the return code is
 * `'delta'` in that case so the caller's "did we ever see
 * content?" book-keeping stays correct.
 */
async function* processFrame(
	frameRaw: string
): AsyncGenerator<SseEvent, 'done' | 'delta' | 'usage' | 'skipped', void> {
	const frame = frameRaw.trim();
	if (frame.length === 0) return 'skipped';
	if (frame.startsWith(':')) return 'skipped'; // SSE comment

	// SSE allows multiple field types; we only care about `data:`.
	// Non-`data:` lines (id:, event:, retry:) are silently ignored.
	const dataLines: string[] = [];
	for (const line of frame.split(/\r?\n/)) {
		if (line.startsWith('data:')) {
			dataLines.push(line.slice('data:'.length).trimStart());
		}
	}
	if (dataLines.length === 0) return 'skipped';

	const payload = dataLines.join('\n');
	if (payload === SSE_DONE) return 'done';

	let parsed: OpenAIStreamFrame;
	try {
		parsed = JSON.parse(payload) as OpenAIStreamFrame;
	} catch {
		// Skip malformed JSON; one bad frame is not worth tearing
		// down a multi-second stream. Caller's content is still
		// likely correct.
		console.warn('[sse-parser] skipping malformed frame:', payload.slice(0, 100));
		return 'skipped';
	}

	const choice = parsed.choices?.[0];
	const finishReason = choice?.finish_reason;
	const delta = choice?.delta?.content;

	if (finishReason === 'error') {
		throw new Error(`upstream stream error: ${delta ?? '(no detail)'}`);
	}

	let yieldedDelta = false;
	if (typeof delta === 'string' && delta.length > 0) {
		yield { kind: 'delta', text: delta };
		yieldedDelta = true;
	}

	// Usage may appear on its own frame (typical OpenAI shape) or
	// piggy-backed on the final content frame (some adapters).
	const usageRaw = parsed.usage;
	if (
		usageRaw &&
		typeof usageRaw.prompt_tokens === 'number' &&
		typeof usageRaw.completion_tokens === 'number' &&
		typeof usageRaw.total_tokens === 'number'
	) {
		yield {
			kind: 'usage',
			usage: {
				input: usageRaw.prompt_tokens,
				output: usageRaw.completion_tokens,
				total: usageRaw.total_tokens
			}
		};
		if (!yieldedDelta) return 'usage';
	}

	if (yieldedDelta) return 'delta';
	return 'skipped';
}

/**
 * Index of the next `\n\n` or `\r\n\r\n` boundary in `s`, or `-1`.
 * The returned index is the start of the boundary; use `frameLen`
 * to advance past it.
 */
function findFrameBoundary(s: string): number {
	const lf = s.indexOf('\n\n');
	const crlf = s.indexOf('\r\n\r\n');
	if (lf === -1) return crlf;
	if (crlf === -1) return lf;
	return Math.min(lf, crlf);
}

/** Length of the boundary at index `i` in `s` (2 for `\n\n`, 4 for `\r\n\r\n`). */
function frameLen(s: string, i: number): number {
	return s.startsWith('\r\n\r\n', i) ? 4 : 2;
}
