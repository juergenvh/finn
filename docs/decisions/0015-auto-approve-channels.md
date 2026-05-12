# ADR 0015 — Auto-approve channels: topology, audit, loop defences

- **Status:** accepted
- **Date:** 2026-05-09
- **Deciders:** Jürgen, Dixie
- **Related:** ADR-0005 (approval flow), ADR-0014 (user-triggered
  forwarding), issue #28, transcript with Wintermute / Dixie /
  Gwen on 2026-05-09 (in workspace daily log).

## Context

Issue #28 was opened as a quality-of-life feature: a per-channel
toggle that skips the human-in-the-loop approval for
agent-to-agent mentions. The minimal reading is "remove
friction in channels where the user trusts the dynamic".

A discussion between three agents (Wintermute, Dixie, Gwen) on
2026-05-09, mediated by Jürgen, sharpened this into a topology
question rather than a UI affordance. The transcript surfaced
three failure modes of an auto-approve channel that the toggle
description did not address:

1. **Mention-loops.** Without a router gating each hop, two
   agents that mention each other can pingpong indefinitely.
   Trivial to defend against; must be built consciously, not
   assumed.
2. **Consensus drift.** Two agents from the same model family
   (e.g. two Anthropic-Claude-lineage agents) are *not* two
   independent data points. They share a bias vector and find
   agreement faster than warranted. The human as router is
   today's external validator; without it, that layer is gone.
   Strictly an epistemic problem — no code fix, only
   configuration awareness.
3. **"Who has the last turn?"** With approval, the human ends
   each round. Without it, the question is open and agents that
   don't know when to stop, don't.

This ADR pins the design that addresses (1) and (3) directly,
and gives the user the information they need to address (2)
themselves — without finn pretending to be able to evaluate
agent configurations on its own.

## Decisions

### 1. finn surfaces facts; the user decides

finn is a routing tool, not a configuration evaluator. It does
not:

- evaluate whether a channel's agent set is "sufficiently
  diverse" (would require knowledge of model families and
  training corpora — outside scope)
- infer the channel's purpose from message history
- block auto-approve activation under any configuration
- recommend for or against activation
- ask agents to self-classify their model family or training
  lineage

What finn does: surfaces the facts the user already implicitly
committed to when configuring the channel, in a pre-activation
audit, and lets the user decide.

This boundary is **load-bearing**. Crossing it would put finn in
a position to make claims about LLM ecosystems that it has no
ground truth for, and would centralise judgements that should
stay with the user.

### 2. `agents.role_label` — generic plumbing, not auto-approve-specific

Add a nullable `role_label TEXT` column to `agents`. Populated
optionally on agent creation via a "capability probe" (see §3),
refreshable on demand from the agent's edit form, displayed in
bubbles next to the agent's name when set (`dixie · helper ·
10:42`).

`role_label` is **general-purpose plumbing** — useful in the
audit modal below, useful in bubbles independently, useful in
the protocol viewer later. It is not an auto-approve-specific
feature, and a future PR can land it on its own (and probably
will, ahead of the rest of this ADR).

The label is treated as **opaque user-visible string**:
- Server lower/trim normalises only for the duplicate-detection
  match in the audit modal (§4).
- No semantic interpretation. If a backend returns
  `🪦 ROM-construct`, that is the role label.
- No validation beyond "non-empty after trim". Backends that
  reply with a sentence get a sentence; backends that reply
  with a single word get a single word. Display is truncated
  in narrow contexts (bubble header) but the full string is
  what's stored.

### 3. Capability probe — opt-in, off by default

When creating an agent, the form offers an optional **capability
probe**: a small `chat/completions` request to the configured
backend asking the agent to describe its function/role in 1–2
words. Default state of the checkbox: **off**.

```
[ ] Run capability probe
    (sends a small chat-completion request to derive a role label;
     uses tokens against your configured backend)
```

The probe prompt:

> "Describe your function/role in this channel context in 1-2
>  words. Reply with just the words, no sentence."

Probe outcomes:

- **Reply received**: stored verbatim into `role_label`
  (post-trim, post-length-cap). Cap at, say, 64 chars to
  prevent a runaway "describe yourself" essay from fouling the
  bubble header; truncated body cached as-is.
- **Backend unreachable / non-2xx / empty content**: agent is
  created with `role_label = NULL`. A toast informs the user
  ("could not reach agent — added anyway, refresh later in
  edit") and creation succeeds.
- **Probe opt-out (default)**: no call made,
  `role_label = NULL`.

### Why off-by-default

The probe costs tokens. ADR-0013 phase 2b made per-message
token costs visible to the user via the bubble footer (#43);
the same honesty applies here — finn should not silently spend
tokens on the user's account without an explicit opt-in. The
form is a one-line decision with no surprise.

### Edit-form refresh

The agent edit form gets a `↻ Reload` button next to the
read-only `Role: <label or —>` display. Clicking it runs the
same probe and updates `role_label`. No auto-refresh, no
scheduled re-probe — the user owns the timing.

This handles agents whose role evolves (e.g. Wintermute's
persona prompt changes upstream) and agents that were created
without a probe and the user later wants one.

### 4. Pre-activation audit modal

When the user toggles "auto-approve" on a channel, finn shows
a modal **before** the toggle takes effect. The modal contains:

#### 4a. Channel-member table

| agent | connector | base_url | model | role |
| ----- | --------- | -------- | ----- | ---- |
| dixie | openclaw  | http://… | openclaw/dixie | helper |
| gwen  | openclaw  | http://… | openclaw/gwen  | local-llm |
| wintermute | openai-compatible | https://agent.storm7.de/v1 | wintermute | strategist |

Read-only. Sourced from the `agents` table; `role_label` shown
as `—` when null.

#### 4b. Mechanical flags

Two flags, computed from the table itself with no semantic
interpretation:

- **Same role_label** (lowered, trimmed) between two or more
  members → "These agents declared the same role: …".
- **Same base_url** between two or more members →
  "These agents share a backend at …".

These are **observations**, not warnings. No red colour, no
"this is risky" copy. Just "you may want to know:".

#### 4c. Activation explainer

A static block describing what enabling auto-approve means in
this channel:

- agent-to-agent mentions skip the approval gate
- routing happens **per channel**; other channels keep their
  current behaviour
- loop defences apply (§5)
- can be turned off again at any time, no migration

#### 4d. Confirm / cancel

Two buttons. "Enable auto-approve" commits the toggle.
"Cancel" closes the modal with no DB change.

The audit modal does **not** run a fresh capability probe
against any agent. Probing is the user's choice; if they want
the audit to reflect the latest role labels, they refresh from
the edit form first. (Probing from the modal would hide token
cost behind a UI flow that does not announce it.)

### 5. Loop defences

Built into the auto-approve dispatch path, not bolted on later.

#### 5a. Roundtrip cap per (last-user-message) window

Every user message in an auto-approve channel opens a
"window". Within a window, each agent may emit at most **N**
messages that mention another agent (default `N = 3`,
configurable per channel later). Once the cap is hit, further
mentions from that agent are persisted but **not** auto-routed
— they fall back to the regular pending-approval flow.

The cap resets on the next user message.

This contains the worst case (two agents pingpong) without
killing legitimate multi-turn coordination. Three roundtrips
is enough for a substantive exchange; more than that probably
needs the user back in the loop anyway.

#### 5b. NO_REPLY as first-class

Agents replying with `NO_REPLY` (or equivalent empty /
explicit-no-content responses; exact match list pinned during
implementation) are treated as having received-but-not-replied.
finn:

- does **not** persist a bubble for this turn
- does **not** count it against the roundtrip cap
- does **not** emit a `message_*` lifecycle (no streaming
  bubble appears at all)

This is the most important loop defence socially: agents must
have a way to *not respond*, and that way must be free of
side effects. Without it, any agent that "reads" a mention is
forced to "say something", and the social pressure produces
content even when none is warranted.

NO_REPLY discipline is an agent-side responsibility (each
agent decides when to use it); finn-side is the absence of
penalty.

#### 5c. Per-channel concurrent-stream ceiling

A hard cap on how many message streams can be in flight
simultaneously in one channel (default 4, equal to the
practical Anthropic concurrent-call limit on a single API key
today). Beyond the ceiling, mentions queue rather than firing
in parallel. This protects against cascading mention storms
where N agents all mention each other in one turn and produce
N² inflight calls.

The cap is **hard** — exceeding requests do not silently drop;
they wait. If queueing length exceeds another (much larger)
threshold, finn surfaces a system event and stops auto-routing
until the user intervenes.

### 6. Audit row shape

When the auto-approve toggle takes effect on a channel, an
agent-to-agent mention in that channel produces an approval
row in `routed` status (not `pending`), exactly like ADR-0014's
user-triggered-forward path. The differences:

- `created_via` (or equivalent column to be decided during
  implementation) marks it as `auto_approve` rather than
  `forward` or `mention`. This lets the protocol viewer
  distinguish them in audit.
- The row is created by finn at routing time, not by a user
  click.

This is the **single addition** to ADR-0014's audit-row model;
the rest of the schema stays unchanged.

### 7. Out of scope

- **Family-disjointness as a hard constraint.** Initial
  instinct (mine, walked back): "auto-approve forbidden when
  channel members are all in one model family". Decided
  against — finn cannot reliably detect family without
  LLM-level knowledge, and the user owns the configuration
  decision. The audit modal surfaces the relevant facts; the
  user weighs them.
- **Channel-purpose inference.** finn does not read message
  history to derive what the channel is "for".
- **Per-agent auto-approve allowlists.** Channel-level only.
  An agent that should be auto-approve in some channels and
  not others is configured by being a member of those channels
  and not the others.
- **Re-probing role_label on schedule.** User-triggered only.
- **Cross-channel auto-approve policies.** Each channel
  decides independently.

## State machine impact

ADR-0005's approval state machine is unchanged. Auto-approve
adds a *trigger* — when the channel has the flag set, an
agent-to-agent mention produces a row directly in `routed`
state, same as ADR-0014's forward. The
`pending → approved → routed` transition is one of three ways
a row reaches `routed`; user-forward and channel-auto-approve
are the other two.

## Persistence

- New column `agents.role_label TEXT NULLABLE` (§2-3).
- New column `settings_channel.auto_approve INTEGER NOT NULL
  DEFAULT 0` (boolean flag; SQLite stores as 0/1). *Shipped
  as part of ADR-0019 (migration `0004_slippery_warlock.sql`),
  ahead of the routing path that reads it.* The original ADR
  text said `channels.auto_approve`; ADR-0019 settled per-channel
  override storage on the `settings_channel` table, so this is
  where the flag lives. Precedence: channel override only —
  there is no global default for this key (§1 boundary: every
  auto-approve activation is an explicit, per-channel opt-in).
- New column `approvals.created_via TEXT` carrying one of
  `'mention'` / `'forward'` / `'auto_approve'`. NULL for
  pre-feature rows; readers default missing values to
  `'mention'`. *Decision during implementation: yes, ship it.*
  Migration `0005_third_marvel_apes.sql`. The protocol viewer
  PR can rely on the column being present and only needs the
  NULL-→-`mention` fallback for backfill.
- New module `src/lib/server/channel-settings.ts` with
  `readAutoApprove(channelId)` for server-internal hot-path
  reads (the HTTP `/api/settings` handler keeps its own
  duplicated read path; sharing was rejected to avoid a
  fetch-from-localhost detour in the dispatch path).

## Wire protocol additions

When auto-approve is active in a channel, the WS sequence for
an agent-to-agent message is:

```
message_start (per recipient)
message_delta×N (per recipient)
message_end (per recipient)
approval_created   ← status: 'routed' from the start
```

No `pending` event is ever emitted on this path. The client
already handles `routed` snapshots correctly (ADR-0014 path);
no client changes are strictly required, though the channel
view may want a small badge indicating auto-approve is active
in the channel header.

## Implementation phasing

Recommended split into three PRs, landable in order:

1. **`role_label` plumbing.** Schema migration, capability-
   probe-on-create (opt-in checkbox), edit-form reload
   button, bubble display. Useful on its own; closes the
   "show role next to name" half of the discussion
   independently of #28. Can land as soon as accepted.
2. **Loop defences.** Roundtrip cap, NO_REPLY first-class
   handling, per-channel concurrent-stream ceiling. Also
   useful independently — applies to *all* channels, not just
   auto-approve, and a few of these (NO_REPLY being free of
   side effects) are arguably bug fixes for current behaviour.
3. **Auto-approve toggle + audit modal + routing path.** The
   feature itself. Lands last because it depends on (1) for
   the audit and (2) for the safety net.

   *Shipped in two PRs: the toggle UI + storage in PR #72
   (ADR-0019 phase 2 — the column piggybacked on the settings
   surface PR rather than waiting). The routing path landed
   separately as feat/auto-approve-routing on top of
   ADR-0020's loop defence. The audit modal (pre-activation
   warnings + role-label table) is still TBD; the toggle
   today is a plain checkbox with a text hint, and the
   role-label plumbing of phase 1 has not yet shipped — those
   two pieces are the remaining work.*

If Jürgen prefers to ship (1) ahead of accepting the rest of
this ADR (because role labels are useful even without
auto-approve), that is fine; this ADR records the design
context, the implementation can stage in.

## Consequences

- ADR-0005's no-auto-approve invariant is **partially relaxed
  per channel, by user opt-in, with audit**. The closing line
  of ADR-0005 ("there is no auto-approve, no whitelist, no
  safe bypass") is updated to: there is no auto-approve
  *enabled by default*, no whitelist, and any opt-in carries
  a pre-activation audit and built-in loop defences.
- The protocol viewer (ADR-0010) sees auto-approve-routed
  rows uniformly with mention-routed and forward-routed rows.
  A `created_via` column or equivalent (§Persistence) lets the
  audit surface distinguish them if useful.
- finn now stores a per-agent free-text label that originates
  from a capability probe call. This is the first piece of
  agent state that came from the agent itself rather than the
  user form. The pattern is general enough that future
  features (e.g. agent-self-described capability tags) plug
  in alongside without further ADRs.
- The audit modal is the first UI surface where finn shows
  the user multiple facts and asks them to weigh trade-offs
  with no recommendation. The pattern (facts, mechanical
  flags, no judgement, user owns the call) is one we will
  probably reach for again — pinning it as a precedent.
