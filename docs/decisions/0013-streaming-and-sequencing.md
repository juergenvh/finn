# ADR 0013 — Token-streaming and reply-sequencing for assistant messages

- **Status:** **draft** (not yet accepted; this is the plan we agreed
  on the evening of 2026-05-08, to be implemented in a feature
  branch)
- **Date:** 2026-05-08
- **Deciders:** Jürgen, Dixie
- **Related:** Issue #3 (token-streaming), comment on #3 (reply
  sequencing), ADR-0005 (approval flow), ADR-0001 (connector auth),
  ADR-0002 + 0012 (session-key format).

## Context

Today, when a user sends a message to a multi-agent channel, finn:

1. Persists the user turn and emits it (immediate).
2. Calls every recipient's connector via
   `dispatchUserMessage(...)` which awaits **all** of them through
   `Promise.allSettled(...)`.
3. After every connector has resolved, iterates the results, persists
   each agent reply, and emits a `message` event per reply.

There are two problems with this shape, both reported during
end-to-end testing on 2026-05-08:

**Problem 1 — replies arrive in a single visible burst.** Even when
agents have very different latencies (a Wintermute call against
Anthropic Opus might take 5–15s; a Gwen call against local Ollama
Qwen 3.6 might take 10–30s), the user sees nothing for the duration
of the *slowest* call, then all replies appear at once. There is
no progressive feedback that work is in flight.

**Problem 2 — no token-by-token streaming.** Even within a single
agent's reply, the user waits for the full string before any byte
is shown. For a multi-paragraph response from a thinking model,
this can be 10–20s of dead air followed by a wall of text.

Both connector-targets we run today already support streaming on
their wire:

- OpenClaw's OpenAI-compatible HTTP API documents `stream: true`
  with SSE frames (`data: {chunk}\n\n` ... `data: [DONE]`).
- The Wintermute adapter (PR-39 + 40 of `juergenvh/wintermute`)
  emits the same SSE shape, today as a single content delta but
  with the full frame sequence already in place.

The bottleneck is on finn's side, not on the backends.

## Decision

Implement **per-message token streaming** end-to-end, and switch the
multi-agent dispatch from "wait for all then emit" to
"emit-as-each-arrives". The two changes share a code path; doing
them together is cheaper than doing them sequentially.

### Wire shape (server → client over WebSocket)

Replace the single `message` event with a three-event lifecycle for
agent-authored messages. User and system messages keep their
existing single-event form (they are never streamed).

```ts
type WSInbound =
    // existing forms, unchanged:
    | { type: 'message'; ... }            // user / system messages
    | { type: 'approval_created'; ... }
    | { type: 'approval_updated'; ... }
    | { type: 'system'; ... }
    | { type: 'pong' }
    // new forms, agent-message-only:
    | { type: 'message_start';
        id: string;                       // final message id
        channel_id: string;
        sender_id: string;                // agent id
        ts: number;                       // start time, UI uses this
                                          // for the bubble's timestamp
      }
    | { type: 'message_delta';
        id: string;                       // matches message_start.id
        delta: string;                    // append to the bubble's body
      }
    | { type: 'message_end';
        id: string;                       // matches message_start.id
        body: string;                     // full final body, in case
                                          // the client wants to reconcile
      }
    | { type: 'message_error';
        id: string;                       // matches message_start.id
        error: string;                    // stable enough for an i18n
                                          // map, but not a contract
      };
```

`message_start` arrives the moment a connector call begins, so the
client can render an empty agent bubble with a "thinking…" indicator
immediately. `message_delta` arrives once per token-or-chunk from
the upstream stream. `message_end` lands when the connector's stream
terminates cleanly. `message_error` lands on any mid-stream failure
and is mutually exclusive with `message_end` for a given `id`.

User messages keep the existing `message` event because there is no
streaming to do — the body arrives whole from the form.

### Persistence shape

A streamed agent reply is **one row in the messages table**, written
when the stream completes. Mid-stream the reply lives only in
WebSocket frames + the client's in-memory buffer. This keeps the
persistence contract (ADR-0004 append-only, `messages.body` is the
final bytes) intact and avoids a half-written-row state.

If a stream fails mid-flight, no row is written; the client sees
`message_error` and discards the partial buffer. The client may
optionally surface a `system` event noting the failure, the same
way per-agent errors are surfaced today.

This means the protocol viewer (audit surface) sees only completed
messages — same as today. There is no "in-flight transcript" notion;
the viewer is still a record-of-completed-turns, not a real-time
mirror.

### Dispatch shape

Replace `Promise.allSettled` in `dispatchUserMessage` with
**parallel async iteration**. Each agent's stream is consumed
independently; events go to `emit` as they arrive. The function
returns when every stream has terminated (cleanly or with error).

Pseudocode of the new shape:

```ts
async function dispatchUserMessage(args, emit) {
    const recipients = ...;  // existing mention-filtering logic
    await Promise.all(recipients.map(async (agent) => {
        const messageId = newMessageId();
        emit({ type: 'message_start', id: messageId, ... });
        let fullBody = '';
        try {
            for await (const chunk of agent.streamReply(args.body, args.channelId)) {
                fullBody += chunk;
                emit({ type: 'message_delta', id: messageId, delta: chunk });
            }
            const row = recordAgentMessage({ id: messageId, body: fullBody, ... });
            emit({ type: 'message_end', id: messageId, body: row.body });
            // approval-creation logic, unchanged from today
        } catch (e) {
            emit({ type: 'message_error', id: messageId, error: e.message });
        }
    }));
}
```

The `Promise.all` here returns when all dispatches have terminated;
the caller (`handle-user-message.ts`) does not need to walk a
`results` array because each per-agent path emitted what it needed
during its own stream.

### Connector contract

Both connectors gain a `streamReply(body, channelId)` method that
returns an `AsyncIterable<string>`. The signature mirrors `send`
(which stays for back-compat / non-streaming paths) but yields
chunks instead of returning a string.

```ts
export type StreamReply = (args: { channelId: string; body: string; config: Cfg })
    => AsyncIterable<string>;
```

Internally, both connectors set `stream: true` in the body and
parse `text/event-stream` frames using a small shared SSE-parser
helper. Each `data: {...}` frame's `choices[0].delta.content` is
yielded; `data: [DONE]` ends the iteration.

The helper handles:
- Reassembly of frames split across HTTP chunks.
- The `finish_reason: "error"` / mid-stream-error chunk that
  Wintermute's adapter can emit (PR #40).
- Streams that close without `[DONE]` (network drops): treat as
  a clean end-of-stream if any content was received, otherwise
  bubble as an error.

### Approval-flow interaction

The agent-to-agent approval flow (ADR-0005) creates a pending
approval *after* the agent's reply lands and contains an `@-mention`.
With streaming, this check still runs — but only after
`message_end`, against the full assembled body. Mid-stream we don't
speculate.

Practically: an `approval_created` event for the relayed message
arrives *after* `message_end` for the originating reply. The client
sees the agent finish, then the approval picker pops up. This
matches today's perceived flow for the user.

### `dispatchToAgent` (the relay path used after approve)

`handle-approval-decide.ts::handleApprovalDecide` also calls
connectors. The same streaming + sequencing logic applies there:
each relayed agent's reply is its own stream of
start / deltas / end events; the existing `Promise.allSettled`
loop becomes parallel async iteration. `markRouted()` runs once
**all** relays have terminated (clean or error), same as today.

## Migration

There is no DB migration. The schema does not change; only the
WebSocket wire and the connector function shape do.

Clients connected over older versions of finn would receive the new
event types and fail to parse them; we are single-user pre-public,
so this is a deploy-then-restart situation, not a contract break.

ADR-0002 + 0012's session-key format is unaffected — streaming
operates **inside** a single `chat/completions` call, which already
has its session-key set per the existing connector logic.

## Consequences

**Positive.**

- Real progressive feedback: the user sees agent bubbles begin to
  fill within ~200ms of sending, instead of waiting for the slowest
  agent.
- Multi-agent channels become genuinely multi-agent in the UX: each
  agent's bubble grows at its own pace, in parallel, instead of
  the channel pretending nothing is happening then dropping a
  fully-formed wall.
- Mid-stream errors fail gracefully (`message_error`) instead of
  bubbling out as a dispatcher-level system event with no message
  context.
- Connector contract stays simple — one new function, one shared
  SSE-parser helper, no per-connector streaming reinvention.

**Negative.**

- Two new code paths to maintain (streaming and non-streaming
  `send`). We can deprecate `send` once both connectors have
  `streamReply` and every caller uses it; until then, both live
  side by side.
- Mid-stream client disconnect is messy: the server keeps consuming
  the upstream stream until completion (because cancelling
  upstream is fragile and providers charge for tokens generated),
  but emits to no listener. Acceptable cost for now; revisit if it
  shows up as a real problem.
- Bubble-rendering needs to handle a partial body (no Markdown
  finalisation, no syntax highlighting) until `message_end`.
  Coordinated with #1 (rich-rendering) below.

## Backend streaming maturity (per-target reality check)

The ADR talks about "token-by-token streaming". What each backend
actually delivers today differs:

| Backend                    | Wire supports `stream: true` | Real token-by-token? |
| -------------------------- | ---------------------------- | -------------------- |
| OpenClaw → Anthropic       | yes                          | yes (Anthropic SSE passes through) |
| OpenClaw → Ollama (Gwen)   | yes                          | yes (Ollama streams) |
| Wintermute (`/v1/*`)       | yes                          | **no, single chunk today** — the adapter wraps `agent.chat()` which returns a string. Real streaming is a future Wintermute change; the wire contract here is already correct so finn does not refactor when it lands. |
| `anthropic-stub`           | n/a                          | n/a (canned replies, single emit)  |

For Wintermute today, finn will still see a `message_start`,
*one* `message_delta` carrying the full reply, then `message_end`.
The sequencing win (other agents not blocked by Wintermute's
5–15s call) still applies, because the dispatcher emits per-agent
as streams complete in parallel.

This is acceptable: the sequencing fix delivers most of the
perceived UX improvement; per-agent token streaming is the icing.

## Coordination with rich-rendering (#1)

#1 (Markdown / code-block rendering in bubbles) and #3 (this ADR)
overlap because Markdown wants a *complete* document to render
correctly; mid-stream you have half a code fence, an open list
item, an unbalanced bold marker.

Two viable strategies:

- **Render-as-plain-while-streaming, switch-to-markdown-on-end.**
  Simple. The bubble shows monospace text (matches the new
  bubble font) until `message_end` fires, then re-renders as
  Markdown. The visual "click" is mild because the font already
  is monospace and most content stays where it is.
- **Streaming Markdown renderer.** Several libs handle partial
  Markdown gracefully (`marked` with a custom token mode, or
  `streaming-markdown`). More moving parts.

Decide when implementing #1, after streaming lands. Default
recommendation: strategy 1 for the first cut, revisit if the
flicker on `message_end` is jarring.

## Implementation phases (suggested)

1. **Connector streaming, behind a feature flag.** Land
   `streamReply` on both connectors with the SSE-parser helper.
   `dispatchUserMessage` keeps using `send` for now, but a unit
   smoke-test exercises `streamReply` directly. Risk-isolated.
2. **Switch the dispatcher.** Replace `Promise.allSettled` with
   parallel async iteration that consumes `streamReply` and emits
   the new event types. Update `WSInbound` and the client handler
   in lockstep. This is the visible UX flip.
3. **Same for `dispatchToAgent` / approval-routing.** Same shape as
   step 2, in `handle-approval-decide.ts`.
4. **Coordinate with #1** for the rendering side.
5. **Sweep `send` once both callers are on `streamReply`.** Optional
   tidy-up; can stay if removing it has surprising callers (none
   today, but check).

## Touched files (anticipated)

- `src/lib/server/connectors/openclaw.ts` — add `streamReply`.
- `src/lib/server/connectors/openai-compatible.ts` — add `streamReply`.
- `src/lib/server/connectors/sse-parser.ts` (new) — shared helper.
- `src/lib/server/connectors/registry.ts` — add `streamConnector`
  dispatch; keep `callConnector` for back-compat.
- `src/lib/server/handle-user-message.ts` — switch to parallel
  async iteration with start/delta/end emits.
- `src/lib/server/handle-approval-decide.ts` — same switch on the
  relay path.
- `src/lib/server/ws/attach.ts` — extend `Emit` union with the new
  event shapes.
- `src/lib/ui/types.ts` — extend `WSInbound`.
- `src/routes/+page.svelte` — handle `message_start` /
  `message_delta` / `message_end` / `message_error`; keep an
  in-flight buffer per message id.
- `src/lib/ui/MessageBubble.svelte` — render a streaming bubble
  variant (plain-text-while-streaming, finalised on end).
- `docs/connectors.md` — note that both connectors now stream.
