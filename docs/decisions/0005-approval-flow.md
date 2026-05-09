# ADR 0005 — Approval flow for cross-agent traffic

- **Status:** accepted
- **Date:** 2026-05-07
- **Deciders:** Jürgen, Dixie
- **Supersedes:** —
- **Amended by:**
  - **ADR-0014** (2026-05-09) extends the trigger table with
    user-triggered forwarding (↗ button on a bubble): a second
    legitimate routing form, lands directly in `routed` status,
    same audit-row shape.
  - **ADR-0015** (2026-05-09) extends the trigger table with
    per-channel auto-approve. The closing invariant below is
    reworded there: no auto-approve **enabled by default**, no
    whitelist, opt-in carries a pre-activation audit and built-
    in loop defences.
- **Related:** README §"Approval flow"

## Context

The README defines finn's central premise:

> User-originated messages skip the approval step — they're already
> human-decided. The approval gate exists strictly to mediate
> agent-to-agent traffic.

This ADR pins **how** the gate works: which messages go through it,
what the sender sees, what the user does, and how the UI exposes the
decision surface.

Five design questions had real options behind them. This ADR records
the choices, not the deliberation; the discussion is in the daily log
for 2026-05-07.

## Decisions

### 1. When does an approval happen

| Direction         | Approval? | Notes                                                                         |
| ----------------- | --------- | ----------------------------------------------------------------------------- |
| User → Agent      | No        | Already human-decided. Direct dispatch.                                       |
| Agent → User      | No        | The user is the recipient by definition; approving your own incoming mail is theatre. |
| Agent → Agent     | **Yes**   | The whole point of finn. Every cross-agent hop pauses for explicit approval.  |
| Agent → System    | n/a       | System messages are emitted by finn itself, not received from connectors.     |

A 1:1 channel (one user + one agent) therefore sees zero approvals.
A multi-agent channel (one user + N agents) sees an approval whenever
an agent's message has at least one *other agent* as a recipient.

### 2. Addressing model

When an agent's message contains `@<agentName>` or `@<agent_id>`
mentions, those mentions become the **default target set** for the
approval. The user can:

- approve as-is (relay to the mentioned agents)
- modify the target set (add agents, drop agents, retarget entirely)
- approve with the user as the only effective audience (= no relay,
  but the message is recorded and shown)
- reject (with optional reason)

Mentions are a convenience, not authority. The user's choice in the
approval UI is what actually routes.

A message with no `@-mention` defaults to "user only" — the agent
spoke, the user heard, nothing further is relayed.

### 2b. Multi-agent fanout on user messages

A user message into a channel with N agents fans out to all N
agents in parallel — no approval needed (the user's message is
already human-decided per ADR-0005 §1).

Each agent independently produces a reply. Each reply is then
subject to the rules in §1: a reply with cross-agent mentions
requires approval before it relays to those agents; replies with
no mentions just sit in the channel for the user to read.

This is the simplest model that makes a multi-agent channel feel
like a multi-party chat: speaking to the room reaches everyone,
but agents addressing each other still pass through you.

### 3. Sender experience

When an agent's reply needs approval, the connector call is **not**
held open until the human decides. Instead:

- The connector call returns synchronously to the originating
  request, carrying the agent's reply as the immediate response.
- finn writes the message into the database and creates a `pending`
  approval row.
- If approved, finn issues a *separate* outbound call to deliver
  the message to the targeted agent(s). That delivery is itself a
  new connector call, with its own session-key context.
- If rejected, no outbound call ever happens.

Consequence: an agent that wrote `@Agent_B can you check this?` does
not block waiting for B's reply. From the agent's perspective, the
message is "out the door" immediately. Whether and how it actually
reaches B happens on a separate timeline — the human's timeline.

This is the structural mechanism that **prevents inter-agent
spirals**: there is no agent-driven feedback loop, only a human-
gated relay.

### 4. UI: inline bubbles, not a separate inbox

Approvals live **inside the message bubble**, in the chat stream.
There is no separate approval inbox, no modal, no second tab.

Each agent message that requires approval renders as a bubble with:

- The message body (preview)
- A **status badge**: `pending` | `approved` | `routed` | `rejected`
- A target picker (checkboxes, pre-filled from `@-mentions`)
- **Approve** / **Reject** buttons
- An optional reject-reason input that appears when the user picks
  Reject

After decision, the bubble keeps its colour (status-dependent), the
buttons disappear, and a small summary line records what happened
("approved → Agent_B at 09:42" or "rejected: 'too speculative'").

A sidebar exists, but it is the **address book**: channels and
agents. Approvals do not appear there.

### 5. Authorization

Single-user MVP. There is no authentication on the approve/reject
endpoint today.

This is documented as a transitional posture, mirroring ADR-0001's
trust-model: finn is bound to loopback today; cross-machine usage
will require the auth-mode migration *and* a per-instance user
identity for finn itself. That is a future ADR.

## State machine

```
                   ┌─────────────────────────────┐
                   │           pending           │
                   │  (created on agent message) │
                   └──────────────┬──────────────┘
                                  │
              ┌───────────────────┼───────────────────┐
              │                                       │
        approve                                  reject
              │                                       │
              ▼                                       ▼
    ┌───────────────────┐                  ┌───────────────────┐
    │     approved      │                  │     rejected      │
    │ (recorded; about  │                  │ (terminal; no     │
    │  to be relayed)   │                  │  outbound call)   │
    └─────────┬─────────┘                  └───────────────────┘
              │
       outbound call
       to each target
              │
              ▼
    ┌───────────────────┐
    │       routed      │
    │ (terminal; targets│
    │  delivered)       │
    └───────────────────┘
```

Status values stored in `approvals.status`:

- `pending` — awaiting user decision
- `approved` — user clicked approve, outbound calls about to fire
- `routed` — outbound calls completed (terminal success)
- `rejected` — terminal, no outbound

`approved` is a transient state. If the server restarts while an
approval is in `approved` (between user decision and outbound call
completing), startup should re-attempt the relay or move to a
failure status. We will add `routing_failed` if/when we hit a real
failure case; for now, the application must not silently leave
rows in `approved`.

(Note: ADR-0004 marks `approvals` as append-only at the row level —
status transitions in place. The row itself is never deleted.)

## Wire protocol additions

WebSocket inbound (client → server) gains:

```ts
{ type: 'approval_decide',
  approval_id: string,
  decision: 'approve' | 'reject',
  targets?: string[],         // agent ids; required when approve
  reject_reason?: string }
```

WebSocket outbound (server → client) gains:

```ts
{ type: 'approval_created', approval: ApprovalSnapshot, message_id: string }
{ type: 'approval_updated', approval: ApprovalSnapshot }
```

The `ApprovalSnapshot` includes a `targets: string[]` field that is
pre-parsed from the row's `targeted_agent_ids` JSON column — clients
should not need to JSON.parse anything from the wire. The full
message row is fetched by the client via
`GET /api/channels/:id/messages` rather than pushed inline; the WS
event only references it by id.

Existing `message` events are unchanged. A bubble's approval state
comes from the `approvals` row attached client-side by `message_id`.

**Streaming.** Server hooks emit each WS event individually as soon
as its data is ready (per `Emit` callback in `attach.ts`), rather
than accumulating and broadcasting all events for a turn together.
A user message therefore appears in the UI within milliseconds of
being sent; agent replies appear when their connectors return; an
`approval_created` arrives between them when an agent reply mentions
another agent. This is a wire-protocol property, not a data model
one, but worth pinning here: the order of events in the stream is
the order events became real on the server.

## Persistence

`approvals` table is already in the schema (migration 0000). Fields
relevant here:

- `id` (ap_*)
- `message_id` → the agent's message that triggered approval
- `status` enum
- `targeted_agent_ids` JSON array (the targets the user committed to)
- `reject_reason` (nullable)
- `created_at`, `decided_at`

If targets need granular per-target delivery status (some delivered,
some failed), we add a `approval_targets` join table later. Today,
we treat the target set as atomic: all targets get the message, or
the row stays in `approved` until they all do.

## Consequences

- Multi-agent channel becomes the first first-class feature — the
  approval flow is what makes it work.
- The seed data needs at least one channel with two agents so the
  flow is testable end-to-end.
- A second connector type is needed to test heterogeneous agent
  conversations. We add an Anthropic stub-connector that returns
  canned text without real API calls; switching it to live API is
  a config change once a key is provided.
- The UI's message component grows from "static body" to "bubble
  with state machine and controls." This is the right place for
  that complexity — the approval IS the message in this product.
- finn never *requests* outbound calls without explicit user
  approval. There is no auto-approve, no whitelist, no "safe"
  bypass.
