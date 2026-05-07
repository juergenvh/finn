# ADR 0004 — Append-only messages, soft-delete elsewhere

- **Status:** accepted
- **Date:** 2026-05-07
- **Deciders:** Jürgen, Dixie
- **Supersedes:** —

## Context

finn's central job is "be the chat router and the chat log." The
`messages` table is the durable record of everything routed through
finn — every user turn, every agent reply, every approval decision
context. A markdown export of a channel is, definitionally, a
formatted dump of `messages` joined with `approvals`.

Three deletion semantics are possible per table:

- **Hard delete:** the row goes away.
- **Soft delete:** a `deleted_at` column hides the row from
  application queries, but the row itself survives.
- **Append-only:** no application code path deletes or hides the row.
  If the operator decides to remove data, they edit the database
  directly with full awareness of what they are doing.

The choice has to be made per table, not globally.

## Decision

| Table            | Policy        | Rationale                                                                       |
| ---------------- | ------------- | ------------------------------------------------------------------------------- |
| `messages`       | Append-only   | The audit trail is the product. The application offers no delete UI.           |
| `approvals`      | Append-only   | An approval decision is part of the audit trail. Same reasoning.                |
| `channels`       | Soft-delete   | Closing a channel is normal usage; the messages stay. `deleted_at` hides it.    |
| `agents`         | Soft-delete   | Decommissioning a connector is normal usage; their past messages stay readable. |
| `channel_members` | Hard delete   | Membership is a join row; `LEFT JOIN` semantics carry the meaning if needed.    |

### Why messages are append-only

The README defines finn as a "logbook + audit" surface
(see top-level `README.md` §"Data model"). If the application offers
a delete-message button, two failure modes appear:

1. The user deletes a message in heat of the moment, then needs it
   back. SQLite point-in-time recovery is not configured, so this
   is data loss.
2. An agent (any agent) discovers a delete API and uses it. Agents
   can be tricked, agents can hallucinate, agents can be compromised.
   Removing the API removes the attack surface.

The cost of append-only is that the database file grows. For the
expected use (single user, low message volume), that cost is
negligible compared to the value of an unforgeable transcript.

### How operators delete data

When the human operator decides that a specific row genuinely needs
to disappear (e.g. a leaked secret in a message body), they:

1. Stop finn.
2. Open the database directly with the `sqlite3` CLI or a tool of
   their choice.
3. Delete the row.
4. Restart finn.

This is **explicit, intentional, traceable in shell history, and
not available to any agent.** It is the right level of friction.

### Why approvals are also append-only

A rejected approval is part of the audit story: "the agent proposed
X to be sent to Y, the user rejected it with reason Z." If
rejections were soft-delete-able, the rejection history could be
cleaned up post-hoc, which defeats the audit purpose.

### Why channels are soft-delete

A user closes a channel because they are done with it, not because
they want the messages gone. The desired UX is "this channel no
longer appears in my list." The desired persistence is "the messages
inside it remain readable, the markdown export still works."

A reopened channel (`deleted_at = NULL`) is the same channel; we do
not generate a new id. This mirrors how email-clients treat
archived-then-unarchived threads.

### Why agents are soft-delete

A connector is decommissioned (the user removes their Anthropic API
key, or retires an OpenClaw deployment). Past messages from that
agent must stay attributable to it; the message rows hold
`sender_id` referencing the (now-soft-deleted) agent row. The agent
row stays so the join still works.

### Why channel_members are hard-delete

`channel_members` is a many-to-many join. Membership is a fact
about the present; if I remove an agent from a channel, the messages
they sent while they were members are still in `messages` with the
correct `sender_id`. The join row itself has no historical value —
anything I wanted to know about "when was this agent in this
channel" would be a separate `channel_membership_events` table, and
we do not have one yet.

## Consequences

- The application has no `DELETE FROM messages` or
  `DELETE FROM approvals` code path. CI / review must enforce this.
- `channels` and `agents` queries default to filtering
  `deleted_at IS NULL` unless the caller explicitly opts into the
  soft-deleted set (e.g. an admin view).
- Markdown exports (when implemented) include all messages, even
  those in soft-deleted channels — the export is the audit record.
- Database bloat is accepted. Compression / archival is a future
  ADR if and when message volume warrants it.
- Operators who need to remove data do so out-of-band, with the
  application stopped. This is documented in the operator-facing
  README.

## Addendum 2026-05-07: "immutable but extendable"

The original wording above said "the application has no
`DELETE FROM messages` or `DELETE FROM approvals` code path."
While working on issue #15 (channel grooming) it became clear
that append-only as a stance has two distinct claims tangled
together:

1. **No row deletion** — a stored row stays stored. This part
   is uncontroversial and unchanged.
2. **No row mutation** — once written, the row's columns are
   final. This is the part that needed sharpening.

The sharper rule we are committing to:

> The **content** of a message or approval row is immutable
> once written: `body`, `sender_type`, `sender_id`, `created_at`,
> `id`, and `parent_message_id` on `messages`; `message_id`,
> `created_at`, and `id` on `approvals`. The application has
> no code path that mutates any of those columns after the
> initial INSERT.
>
> **State columns** — columns that record an explicit
> downstream decision *about* the row, made after creation —
> are allowed to mutate. They do not violate append-only
> because they record new information rather than rewriting
> old. Today these are: `approvals.status`,
> `approvals.targeted_agent_ids`, `approvals.reject_reason`,
> `approvals.decided_at` (already mutating per ADR-0005's
> state machine). Issue #15 adds `messages.hidden_at` and
> `messages.hidden_by` to this list — visibility flags that
> mark a user's grooming decision without altering content.

For the channel-view path, groomed messages
(`hidden_at IS NOT NULL`) are filtered out. For the protocol
viewer (issue #14) and for markdown exports, the visibility
flag is informational only — those surfaces show the row
regardless. That gives the user real channel-grooming
control without compromising audit honesty.

## Addendum 2026-05-07: schema migrations are "immutable but extendable"

A related discipline that came up at the same time: when the
schema grows, existing data must not be reshaped by the
migration.

The rule:

- **New columns are NOT NULL with a default**, or **NULLABLE
  if the absence of a value carries meaning** (e.g. "this
  message has not been groomed" maps cleanly to
  `hidden_at IS NULL`, where the NULL is the message and a
  default would be misleading).
- A migration may **never** rewrite an existing column's
  value. If new derived information is wanted, store it in a
  new column (or a sibling table) and compute it on the way
  in for new rows; existing rows keep their original content.
- A migration that needs to delete rows is rejected by
  review. Use a soft-delete column or accept the existing
  data; out-of-band SQL is the operator's path, not the
  application's.
- New tables are unconstrained — those have no existing data
  to protect. The discipline is about not retroactively
  rewriting history.

Net effect: every migration leaves the past as it found it.
The schema grows; the data does not retell its own story.
