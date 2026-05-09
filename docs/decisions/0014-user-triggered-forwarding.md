# ADR 0014 — User-triggered forwarding of existing messages

- **Status:** accepted
- **Date:** 2026-05-09
- **Deciders:** Jürgen, Dixie
- **Related:** ADR-0005 (approval flow), ADR-0013 (streaming &
  sequencing), issue #52, PR #53.

## Context

ADR-0005 fixed the approval flow around one assumption: the only
way an agent message reaches another agent is via an
`@-mention` in that message, which becomes a pending approval
the user has to act on. The closing line states:

> finn never *requests* outbound calls without explicit user
> approval. There is no auto-approve, no whitelist, no "safe"
> bypass.

In practice we ran into a missing affordance during testing of
PRs #50/#51: an agent reply contains something a *different*
agent should see, but the originating agent didn't `@-mention`
that other agent. The user knows it should be relayed, but
ADR-0005 only sees one route — `@-mention` + pending approval —
and copy-pasting the body into a new user message works but
breaks the audit trail (the routed message is not flagged as a
relay).

This ADR adds a second legitimate routing form: **user-triggered
forwarding**, where the user explicitly picks an existing
message and one or more channel-member agents to receive it.

## Decisions

### 1. Forwarding is a legitimate routing form, not a bypass

The user's deliberate "forward to X" click *is* the human-in-
the-loop approval that ADR-0005 demands. Forwarding does not
bypass the gate; it is the gate, in a different shape. A
mention-driven approval and a user-triggered forward are both
single, explicit, human-decided routing acts. The closing line
of ADR-0005 stands as written: there is still no auto-approve,
no whitelist, no agent-driven relay.

ADR-0005 §1's table is therefore extended:

| Source                    | Trigger                              | Approval gate         |
| ------------------------- | ------------------------------------ | --------------------- |
| User → Agent              | user types in a channel              | none (already human)  |
| Agent → User              | agent reply with no mentions         | none                  |
| Agent → Agent (mention)   | agent reply with `@-mention`         | **pending → approved → routed** |
| User-triggered forward    | user clicks ↗ on an existing bubble  | **routed directly**   |

### 2. State machine: `routed` directly, no `pending`

A forward creates a single approval row in `routed` status from
the start. No `pending → approved → routed` transition.

```
                user clicks ↗ forward,
                picks N targets, confirms
                          │
                          ▼
                ┌───────────────────┐
                │       routed      │
                │ (terminal; targets│
                │  delivered)       │
                └───────────────────┘
```

`createdAt` and `decidedAt` are both set to the click time so
the audit answer to "when was this routed?" is unambiguous.

The double-row case (a message with a `pending` mention-
approval *and* a user-triggered forward) is allowed: both rows
exist in the DB for audit. The UI today renders only one
approval per message id, so the more recent row wins visually.
This is a known UI simplification noted in PR #53; the
protocol viewer sees both rows correctly.

### 3. Body verbatim, no relay marker

The forwarded body is **literally the original message body**.
No `[forwarded from @author]` prefix, no system annotation, no
header injection. Symmetric with the existing approval-relay
path in `handle-approval-decide.ts`: finn does not paraphrase,
it relays.

The receiving agent therefore has no wire-level signal that
this is a relay rather than a fresh user message. By design.
If future use cases need provenance markers, they go on the
*envelope* (e.g. a separate metadata field in the
`chat/completions` body, or an `x-finn-relay-of` header), not
in the prompt text.

### 4. Source eligibility

Forwardable:

- **Agent messages** (the primary use case)
- **User messages** (also useful — feed your own earlier
  message to a specific agent without retyping)
- Messages of any age (channel members are evaluated at
  forward-click time, not at original-message time)
- Messages that already have an approval row attached (you can
  forward a message that was also pending mention-approval)
- Messages that have been forwarded before (no idempotency, each
  forward creates its own routed row)

Not forwardable:

- **System messages** (no use case)
- **Streaming bubbles** (the row isn't in the DB yet; the
  server's lookup would 404 and the user almost certainly wants
  the *full* reply, not a fragment). The UI hides the ↗ button
  until `message_end` lands.

### 5. Target eligibility

Same constraint as `@-mention` resolution:

- Targets must be **enabled** members of the channel the
  message lives in.
- Off-channel agents are not selectable; an attempt to forward
  to one is dropped with a system-event diagnostic
  (defense-in-depth — the picker only shows valid targets, but
  the server filters again).
- The original author *is* a valid target. Forwarding back to
  yourself is rare but not blocked; it produces a fresh reply
  bubble.
- Multi-target forwarding is supported; each target gets its
  own streaming reply in parallel.

### 6. Wire shape

WebSocket inbound (client → server) gains:

```ts
{ type: 'forward_message',
  message_id: string,
  target_agent_ids: string[] }
```

WebSocket outbound (server → client) reuses the existing types:

- `approval_created` carrying a snapshot whose `status` is
  already `routed`. The UI renders the source bubble's
  "routed to: …" sub-line via the existing approval-display
  machinery — no new wire shape needed.
- One `message_start` / `message_delta` / `message_end` (or
  `message_error`) lifecycle per target, identical to
  `streamUserMessage` and `streamToAgent` in ADR-0013.

### 7. UI: ↗ icon in the bubble's hover toolbar

The bubble's existing hover toolbar (the `×` hide button) is
extended into a small `<div class="toolbar">` that hosts both
the hide button and the new ↗ forward button. Clicking ↗
expands an inline target picker — same checkbox-chip layout as
the approval picker, same confirm/cancel button pair, labelled
`forward → N targets`.

The picker is locally scoped to the bubble (`$state` inside
`MessageBubble.svelte`). Cancel collapses it back to the
toolbar; confirm dispatches the WS inbound and collapses.

After confirming, the bubble immediately gets the
`routed to: <names>` sub-line (from the `approval_created`
broadcast); per-target reply bubbles appear streamed below as
their connectors come back.

The forward picker auto-scrolls its bubble into view on open
(`scrollIntoView({ block: 'end', behavior: 'smooth' })`) so the
confirm button is reachable for bubbles that sat higher in the
channel; without this the picker can land below the viewport
since it grows an existing bubble in place rather than
appending a new one.

## Persistence

No schema change. The new shape uses the existing `approvals`
table:

- `status: 'routed'` from the start
- `targetedAgentIds`: JSON-encoded list of forwarded-to agent ids
- `messageId`: pinned to the *original* message (not the
  forwarded replies — those are regular agent rows)
- `createdAt = decidedAt = click_time`
- `rejectReason: null` (forwards are never rejected; the
  approval row only exists when the user committed to forward)

The protocol viewer and message export read `approvals` rows
uniformly; they do not need to know that a particular row came
from a forward versus a mention-approval. The `rejectReason`
column is not a reliable signal because mention-approvals also
leave it null on the approve path.

If we later need to distinguish the two flows in audit views, a
nullable `created_via` column on `approvals` would carry it
without a data migration; that is a future ADR if it becomes a
real need.

## Recursion

A forwarded reply may itself contain an `@-mention` to a third
agent. ADR-0005's recursion gate applies unchanged: the third-
agent hop is a regular pending approval, not a chained forward.
The user has to make a fresh decision for that hop. This keeps
the human-in-the-loop guarantee intact: forwarding is a single
deliberate act, not a recursive policy.

## Out of scope

- **Forward to a different channel.** The picker today only
  shows agents in the source message's channel. Cross-channel
  forwarding has a real use case (an answer in #lab applies to
  someone in #ops) but raises questions about what
  "session continuity" means when an agent's session-key is
  channel-scoped (ADR-0002). Park until a user asks; tracked
  loosely in the issue thread for #52.
- **Forward with annotation.** "Forward this to gwen and tell
  her this is from yesterday's debrief." Useful but blurs the
  verbatim-relay invariant. If we add it, the annotation goes
  before the body as a separate user-authored message in the
  channel, and the forward body stays verbatim — no inline
  injection.

## Consequences

- **ADR-0005's closing invariant is unchanged.** No new
  auto-approve path was introduced; the user is still the one
  who routes every cross-agent hop. Forwarding is a second
  legitimate trigger shape, not a bypass.
- The `approvals` table now hosts two semantically distinct row
  shapes (mention-approval, user-triggered-forward) that share
  the same schema. Code that reads them treats them
  uniformly; only the protocol viewer might want to surface the
  distinction in a future iteration.
- The bubble UI now carries one more per-message action; the
  toolbar pattern (hover-revealed icon cluster, top-right of
  the bubble) is the home for any future per-message actions
  that follow the same shape.
