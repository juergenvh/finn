# ADR 0007 — CRUD UI architecture

- **Status:** accepted
- **Date:** 2026-05-07
- **Deciders:** Jürgen, Dixie
- **Supersedes:** —
- **Related:** ADR-0001 (auth + scope), ADR-0004 (delete policies),
  issue #5 (the implementation ticket)

## Context

Through the spike, channels and agents existed only as seed-script
output or hand-written SQL. Once the end-to-end showcase landed
(2026-05-07), the cost of "edit the DB to try a new connector"
exceeded the cost of building proper CRUD. Issue #5 tracked that
work.

Several smaller decisions came up during implementation. Each
deserves a short pin so a future reader does not have to re-reason
them.

## Decision 1 — Modal dialogs over inline forms or a settings route

We render the create / edit forms in a generic `<Modal>` overlay
on top of the chat surface.

### Alternatives considered

- **(a) Inline forms in the sidebar.** The `+` button would expand a
  form below the section header. Saves a Modal component.
- **(b) Dedicated `/settings` route.** Sidebar links to a separate
  page. Cleaner separation; needs its own navigation chrome.
- **(c) Modal dialogs** (the chosen path).

### Why (c)

- The forms have 4–8 fields; the sidebar is 240 px wide. (a) was
  visibly cramped in prototyping.
- A separate route (b) is overkill at this size and forces the
  user out of the chat context every time they touch
  configuration. We do not have many users; we do not need
  separate IA.
- The `<Modal>` component is small (~90 LOC including styles) and
  pays back immediately: future settings UI, message-detail
  overlays, and the approval-detail surface (if it ever needs
  more space than the bubble) all reuse it.

### When to revisit

If the configuration story grows — multiple settings categories,
per-agent diagnostics, log viewer launchers, a connector test
runner — the modal-as-only-config-surface starts to feel like a
modal-soup. At that point, consider migrating to a `/settings`
route as a successor ADR.

## Decision 2 — Hardcoded form components per connector_type, not Zod-driven generation

Each connector type (`openclaw`, `anthropic-stub`) has its own
fieldset rendered conditionally inside `AgentForm.svelte`. Adding
a new connector means adding (a) a Zod schema branch in
`db/agent-config.ts`, (b) a new fieldset in `AgentForm.svelte`.

### Alternatives considered

- **(a) Schema-driven form generation.** Expose Zod schemas at
  runtime via an API endpoint, render the form generically. One
  source of truth.
- **(b) Hardcoded fieldsets per type.** Two sources of truth (Zod
  schema + form), but each is small and readable.

### Why (b)

- We have two connector types. Schema-driven generation is a
  build-once-amortise-over-N solution; at N=2 it is pure tax.
- Hardcoded fieldsets give us per-field hint text, format hints,
  link to ADR explanations, and inline tooltips. A generic
  generator would either lose this expressivity or grow into a
  small DSL of its own.
- Connectors are not user-pluggable. The set of types is curated
  in code; adding one is a code change anyway. The UI form being
  in code does not raise the bar.

### When to revisit

When N reaches 4–5 connector types, or when the connector-add
workflow needs to be self-service (e.g. a connector-marketplace
or per-instance custom connectors). Either trigger justifies the
schema-runtime exposure.

## Decision 3 — `connector_type` is locked after agent creation

The `AgentForm` shows the connector-type dropdown disabled in edit
mode. The server-side PATCH handler additionally forces the
discriminator back to the existing value before validating.

### Alternatives considered

- **(a) Allow the user to change connector_type and re-validate
  the config against the new schema.** Most flexible.
- **(b) Lock connector_type at creation; require deleting and
  recreating to switch.** What we chose.

### Why (b)

- A type change invalidates the entire `config` JSON. The user
  would have to re-enter every field anyway, and any value the
  old type expected (e.g. `base_url` for openclaw) probably
  does not transfer to the new type.
- Past messages from this agent reference its id, not its type.
  Changing the type underneath would silently change the
  semantics of historical messages.
- Recreating an agent (delete-and-add) is cheap. Membership has
  to be re-established, but that is the natural cost.

### When to revisit

If we ever introduce connector types that are functionally
equivalent at the message level (e.g. `openclaw-v1` vs
`openclaw-v2`), allowing in-place upgrade between them is a
legitimate v2 feature. That change goes through its own ADR.

## Decision 4 — Soft-delete is "Archive"; disable is "Disable"

In the agent action menu, Disable / Enable toggles `enabled`;
Archive sets `deleted_at`. They are separate UI actions with
distinct semantics:

| Action       | DB effect              | Behaviour                                                            |
| ------------ | ---------------------- | -------------------------------------------------------------------- |
| Disable      | `enabled = false`      | Stays in lists, channels, dropdowns. Does not receive dispatches.    |
| Enable       | `enabled = true`       | Reverses Disable.                                                    |
| Archive      | `deleted_at = <now>`   | Drops out of default lists. Past messages still attribute correctly. |
| (Restore)    | `deleted_at = NULL`    | Not in the UI yet; SQL only. Reverses Archive.                       |

### Alternatives considered

- Collapse the two into a single "active / inactive" flag.

### Why kept separate

- "Out of office" and "no longer at this company" are different
  states. A disabled agent is the first; an archived agent is
  the second. Conflating them either makes "temporarily silent"
  cost too much (archived disappears from the sidebar) or makes
  "decommissioned" cost too little (disabled clutters the
  picker forever).
- `enabled` already existed in the schema before this UI
  iteration. Removing it to merge with `deleted_at` would
  retire a working contract for no gain.

### When to revisit

If the user reports that the distinction is confusing in
practice, fold to one. Today's stance: keep both; review after
a few weeks of real use.

## Decision 5 — Membership change emits a system message

Adding or removing a member of a channel emits a system message
in that channel ("X joined the channel" / "X left the channel"),
both persisted (so the audit trail records the membership event)
and broadcast live so connected UIs see it as it happens.

### Alternatives considered

- **(a) Silent membership changes.** Faster, less noise.
- **(b) Persisted membership-event table separate from messages.**
  Cleanest data model; audit is still possible, but messages
  table stays purely chat content.
- **(c) System message in the channel** (chosen).

### Why (c)

- Multi-agent channels are explicitly designed as conversations
  among the user and several agents (ADR-0005). When the cast
  changes, that is part of the conversation, not an
  out-of-band event.
- The audit story (ADR-0004 §"messages append-only") already
  treats the messages table as the durable chat record. A
  separate event table would force every reader (markdown
  exports, future log surfaces, future search) to join two
  tables for one human-meaningful timeline.
- "Silent" (a) is rejected because it would mean a user
  reading back through the chat would see an agent suddenly
  speaking with no context.

### When to revisit

If the system-message volume becomes loud enough to drown out
chat, we add a UI filter to hide system messages by default,
or we move to (b) and surface the events via UI rather than
via the chat stream.

## Decision 6 — REST endpoints, not WS commands, for CRUD

CRUD writes go through HTTP REST endpoints (`POST/PATCH/DELETE
/api/...`); the WS surface is read-only for these (it broadcasts
`state_changed` notifications that hint clients to refetch).

### Alternatives considered

- **(a) WS-only protocol** for CRUD (e.g. `{ type:
  'create_channel', ... }` over the same socket).
- **(b) REST for writes, WS for live notifications** (chosen).

### Why (b)

- HTTP request/response is the right shape for a write operation
  with a clear success/failure status. WS makes
  request/response simulation possible but ugly.
- HTTP is debuggable with `curl`, scriptable, and hits standard
  middlewares (logging, status codes, idempotency-via-body).
- WS already has its own job: the chat stream and the
  approval-flow events. Mixing CRUD into it would force the
  same socket to multiplex two unrelated request-response
  protocols.
- The cost of the split — clients fire a `fetch` *and* listen
  for a WS event — is acceptable because the "act locally,
  refetch on confirmation" pattern is the standard SvelteKit
  shape anyway.

### When to revisit

If finn ever moves to a no-WS deployment (e.g. SSE-only, or
short-poll), the WS-side notifications become long-poll. Until
that happens, the split is fine.

## Decision 7 — Module instance leak via `globalThis` for the active WS server

Documented in detail as ADR-0008 (its own pin because it
reaches further than CRUD). Cross-reference here so future
readers of CRUD code can find the why.

## Consequences

- The seed script remains the canonical first-time setup, but
  is no longer the only path to a working channel/agent
  configuration. Re-seeding a populated DB is still safe
  (idempotent).
- All write paths re-validate on the server. Clients can be
  bypassed; the database cannot.
- The state_changed broadcast is the single signal that drives
  cross-tab sync. Any future write that should reflect across
  tabs must emit it.
- Hard-delete remains a DBA action. The UI will not grow
  hard-delete buttons; ADR-0004 holds.
