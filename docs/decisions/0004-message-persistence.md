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
