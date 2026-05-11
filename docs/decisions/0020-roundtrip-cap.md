# ADR 0020 — Per-channel roundtrip cap

- **Status:** accepted (shipped 2026-05-11)
- **Date:** 2026-05-11
- **Deciders:** Jürgen, Dixie
- **Shipped via:** this PR.
- **Related:** ADR-0005 (approval flow), ADR-0015 §5 (loop
  defences — this ADR ships §5a), ADR-0019 (settings surface —
  this ADR adds two settings on top).

## Context

ADR-0005 leans on the approval gate as the *only* structural
defence against agent-to-agent mention loops: a recursive reply
that mentions another agent creates a fresh `pending` approval,
human pacing makes spirals impossible.

The moment the per-channel **auto-approve** toggle from
ADR-0015 / Issue #28 starts shipping its PRs, that defence is
gone for channels with the toggle on. ADR-0015 §5 already
sketched three loop defences for exactly this case. This ADR
ships §5a (roundtrip cap) ahead of the auto-approve UI so the
toggle can be flipped with confidence rather than into an
ungated loop.

Why this defence first:

- **Builds without UX friction.** Unlike §5b (NO_REPLY) it adds
  no new semantics to agent replies; unlike §5c
  (concurrent-stream cap) it's a same-channel-scoped counter
  rather than a global resource pool.
- **Catches the prototypical failure.** "Two agents mention
  each other in a tight loop" is the failure mode the cap is
  designed for. Other failure modes (one agent producing
  enormous replies; many agents in one channel mentioning each
  other in a fan-out) are real but secondary.
- **Resets on user message.** The cap is structural for loops,
  not a quota for legitimate multi-turn coordination. As long
  as the user stays in the conversation rhythm — even at one
  message every several minutes — the cap effectively
  disappears.

## Decision

Track agent-to-agent hops per channel. When the count for a
channel reaches the cap, refuse further agent-to-agent
dispatches until the next user message resets the counter.

### Counter semantics

- **Scope:** per channel id, in-memory (process-wide).
- **Increment:** every time an agent reply is about to be
  dispatched to another agent in the same channel.
- **Reset:** on every persisted user message in the channel
  (`recordUserMessage`). The user explicitly stepping into the
  conversation is the signal that the loop, if any, is broken.
- **Cap-hit behaviour:** emit a `system` message to the
  channel naming the cap and how it resets, then skip the
  pending dispatch (no agent call, no further approval row).
- **Server restart:** counter is wiped (in-memory). Acceptable:
  loop-defence is not a quota; fresh start after restart is
  the right behaviour.
- **Manual forward** (`handle-forward.ts`) **does not count.**
  The user explicitly clicked forward; that is human pacing by
  definition. The recursion that a forwarded reply might still
  trigger is handled by the regular per-hop increment, not by
  the forward itself.
- **Approval-with-click** is treated like any other hop: the
  decide handler increments the counter when it actually
  dispatches. Counter resets on the next user message anyway,
  so a human-paced approval flow never trips it in practice.

### Cap value + configurability

- **Default cap value:** 5 hops per user-message window.
- **Global setting:** `settings_global.roundtripCapDefault`,
  default 5 (matches the code-side fallback).
- **Per-channel override:** `settings_channel.roundtripCapOverride`
  (nullable). Same precedence chain as KB-budget:
  channel override → global → compiled fallback.
- **Bounds:** 1..100. A cap of 0 would refuse all hops and is
  excluded; a cap above 100 has no defensive value (well past
  any cost or latency target the user would tolerate).

### Where the increment lives

A single helper:

```ts
// src/lib/server/loop-defence.ts
export function tryConsumeRoundtrip(channelId: string): { allowed: true } | { allowed: false; cap: number };
export function resetRoundtrips(channelId: string): void;
export function readRoundtripCap(channelId: string): Promise<number>; // global+override merge
```

Call sites:

- `messages.ts::recordUserMessage` → `resetRoundtrips`.
- `handle-approval-decide.ts` and ADR-0015's auto-approve path
  (future PR) → `tryConsumeRoundtrip` *before* the
  `streamToAgent` call. On `allowed: false`, emit
  `system` and skip.
- `handle-forward.ts` deliberately *does not* call
  `tryConsumeRoundtrip` for the user-triggered forward itself,
  but a forwarded reply that mentions a further agent goes
  through the normal approval-decide path and is therefore
  bounded.

### What auto-approve sees

In ADR-0015's PR stack, the auto-approve path will resolve
pending mentions and dispatch directly. Each dispatch goes
through `tryConsumeRoundtrip` just like an approve-click
dispatch. The cap thus applies uniformly to both routing modes;
auto-approve does not get a separate budget.

## Alternatives considered

### Cap globally rather than per-channel

Rejected. Two parallel auto-approve channels would cannibalise
each other's budget. Per-channel isolation is the natural unit
since approval, membership, and now budget all scope to a
channel.

### Persist the counter in DB

Considered, rejected. The counter is operational state, not
audit material. Surviving server restart is a non-goal: a
restart wipes any active loop too, and the counter resets on
the next user message anyway. The fastest, simplest
implementation wins.

### Encode the cap as an env var, not a setting

Rejected. The settings surface (ADR-0019) is the right place;
per-channel override is the actual feature users will want
(low-traffic channels: 2 as a hard safety; high-throughput
multi-agent channels: 10).

### Make the cap a soft warning rather than a hard refuse

Considered, rejected. A warning that the loop is *probably*
running away does not stop the loop, which is the entire point
of the defence. Hard refuse with a clear `system` message tells
the user explicitly what happened.

## Consequences

### Positive

- Auto-approve can be enabled per-channel without an
  unbounded-loop failure mode.
- A single helper and call site (one increment, one reset)
  makes the defence cheap to reason about. Easy to extend later
  with §5b (NO_REPLY) and §5c (concurrent-stream cap).
- Settings UX stays consistent with KB-budget: one more pair of
  inputs in the existing `/settings` panes.

### Negative

- In-memory counter means a multi-process deployment (which
  finn does not have today) would have to share state somehow.
  Out of scope; revisit when multi-process becomes a thing.
- A pathological case where the user types one message and the
  agents have 5 legitimate roundtrips of useful coordination
  *plus* a 6th useful one is now blocked. Mitigation: the
  channel-level override lets the user raise the cap; the
  default of 5 is generous for the common case.

### Neutral / follow-ups

- ADR-0015 §5b (NO_REPLY) and §5c (concurrent-stream cap)
  remain unbuilt; their need depends on how this cap performs in
  practice.
- The `system` message emitted on cap-hit is intentionally
  terse. A future UX touch could surface it as a special row
  type in the bubble stream with a "reset by typing" affordance,
  but that's polish, not function.

## Verification

- Unit-testable: `tryConsumeRoundtrip` + `resetRoundtrips` are
  pure-ish (in-memory map). A test that calls increment 5 times,
  observes the 6th refuse, resets, observes a fresh window.
- Integration-testable in the channel view: open a channel with
  two agents, force-mention them at each other (manual
  approval), watch the counter via observable system messages
  on the 6th hop. Auto-approve path acceptance lands with
  ADR-0015's PRs.
