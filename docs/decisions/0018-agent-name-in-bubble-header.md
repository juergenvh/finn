# ADR 0018 — Agent name in message-bubble header

- **Status:** proposed
- **Date:** 2026-05-10
- **Deciders:** Jürgen, Dixie
- **Related:** ADR-0016 (rich rendering), ADR-0017 (agent-bound
  session override), `src/lib/components/MessageBubble.svelte`
  (or equivalent).

## Context

ADR-0017 makes "session-variant of the same upstream agent" a
first-class concept: the user can register multiple agent-registry
rows that point at the same upstream agent under different session
names (e.g. `dixie`, `dixie-finn`, `dixie-sagesmith`). The same
visual avatar may speak from different memory windows in different
channels.

Today's message bubble shows the **sender** but the rendering
historically leaned on either the avatar or a small label — the
exact shape predates ADR-0016's rich rendering refactor, and we
have not nailed down the header format since.

When agent rows multiply (ADR-0017's expected outcome), a user
glancing at a channel needs to know *which* Dixie just replied
without hovering, opening a side panel, or reading the message
content for context clues. The bubble header is the natural
place.

### What the header should communicate

In priority order:

1. **Who** is speaking — the agent's display name as configured
   in the agent registry (`agents.name`).
2. **From which session**, when relevant — session indicator
   for non-default-channel sessions, so a user can distinguish
   `dixie-finn` from `dixie-sagesmith` at a glance.
3. **Backing identity**, when not implied by the name — for the
   case where two distinct agent rows share an underlying
   upstream agent (e.g. `dixie-finn` and `dixie-sagesmith` both
   route to upstream `dixie`). Optional, on hover.
4. **Connector type / model** — power-user info, on hover only,
   not in the header line.

### Proposed header format

```
┌─────────────────────────────────────────┐
│ dixie-finn  ·  finn       ▾ 20:47       │  ← header line (small caps / muted)
│                                         │
│ <message body, ADR-0016 markdown>       │
│                                         │
└─────────────────────────────────────────┘
```

Components:

- **Agent name** (`agents.name`): primary label, slightly
  emphasised. From the agent registry — what the user picked when
  registering.
- **Session badge** (` · <session>`): rendered when the agent has
  a `session_override` (ADR-0017) set, OR when the active session
  is not the channel's default. The badge is a compact tag, not a
  full word; the dot-separator indicates "scoped by".
- **Timestamp**: existing position, unchanged.
- **Disclosure caret** (▾): expands a hover/click panel with
  *Backing agent: `openclaw/dixie`*, *Connector: `openclaw`*,
  *Session-key sent: `agent:dixie:finn`*. Power-user info,
  collapsed by default.

For the default-channel-session case (ADR-0012's shape, no
override), the badge is **omitted** to avoid noise. The header
collapses to just `<agent name>  ▾  <timestamp>`.

### Why a badge, not a tooltip-only treatment

Considered: keep the header as just `<agent name>` and put the
session in the disclosure panel. Rejected: ADR-0017's whole point
is to make multiple sessions visible *as distinct conversation
partners*. Hiding which session a reply came from defeats the
mental-model alignment ADR-0017 commits to. The badge is the
atomic visible signal; the disclosure panel is the deeper drill-in.

### Why not just rely on the agent name being descriptive?

Considered: trust the user to name agents `dixie-finn`,
`dixie-sagesmith` and skip the badge entirely. Rejected for two
reasons:

1. **Naming hygiene varies.** A user might name agents based on
   personality variants ("dixie-strict", "dixie-creative") rather
   than session names ("dixie-finn"). The session is metadata that
   belongs in the UI regardless of how the user named the row.
2. **Override changes are visible.** If a user later toggles
   `session_override` on an existing agent, the badge appears
   without renaming. This is a property of the *current* config,
   surfaced live, not a historical naming choice.

The badge is generated from `OpenclawConfig.session_override`. The
name is the user's free-text choice. Both are independent and
both are shown.

### Channel-default session: badge or no badge

For an agent without `session_override` (ADR-0012's
`agent:<agentId>:finn:<channel_id>` shape), the session is
mechanically the channel id. Showing `· c_w-fq8qo7f1xx` in the
header would be noise — the channel id is already implicit in
"the user is reading this channel". So: **no badge** for the
default shape. Badge appears **only** when an override pins the
agent to a flat session name.

### Non-OpenClaw connectors

The badge is OpenClaw-specific in the **session** sense
(ADR-0017's override field lives on `OpenclawConfigSchema`). Other
connectors (`openai-compatible`, `anthropic-stub`) have their own
continuity contracts (e.g. `openai-compatible` uses the OpenAI
`user` field set to the channel id). For those, no badge is
shown — the ADR-0017 override doesn't apply.

If a future connector grows an analogous concept (e.g. a
named-thread field on `openai-compatible`), this ADR's UI
treatment can be extended at that time. For now: badge only when
the active connector is `openclaw` AND `session_override` is set.

## Decision

**The message bubble header shows the agent's display name as the
primary label, plus a session badge when (and only when) the
agent uses an OpenClaw connector with `session_override` set.**

A disclosure caret reveals connector and session-key details on
demand. Channel-default sessions show no badge.

### Header line shape (final)

| Case                                   | Header                                |
| -------------------------------------- | ------------------------------------- |
| User message                           | `<user name>  ·  20:47`               |
| Agent, no override                     | `<agent name>  ▾  20:47`              |
| Agent, override `"finn"`               | `<agent name>  ·  finn  ▾  20:47`     |
| Agent, override `"sagesmith"`          | `<agent name>  ·  sagesmith  ▾  20:47`|

Spacing/styling: the badge is a single muted token, same line, no
pill background. Visual weight: subordinate to the agent name,
above the timestamp.

### Disclosure-panel contents (on caret click / hover)

- **Backing agent:** `openclaw/<agentId>` (or "default" if no
  explicit agent id in `model`).
- **Connector:** `openclaw`, `openai-compatible`, `anthropic-stub`.
- **Session-key sent:** the literal string the connector sent on
  the last turn (truncated to 64 chars). Useful for debugging
  routing issues without leaving the UI.

The disclosure panel reuses the rich-rendering substrate from
ADR-0016 (no new render path). It is read-only.

## Migration

No data migration. The header is computed from existing agent
config + the message metadata that the dispatcher already records
per turn. No new fields on the messages table.

For existing channels: agents without `session_override` keep the
unchanged badge-less header. Adding `session_override` to an
agent (via ADR-0017's CRUD form) immediately surfaces the badge
on its next reply, with no further user action.

## Consequences

**Positive.**

- Distinguishes session-variants at a glance, supporting ADR-0017's
  "different sessions = different conversation partners" model
  without requiring users to memorise which agent name maps to
  which session.
- Backwards-compatible: agents without overrides see no visible
  change.
- Disclosure panel localises debugging info (session-key sent on
  the last turn) where the user is already looking, reducing the
  "open dev tools to see the wire" reflex.

**Negative.**

- The header gains a fourth visual element (badge) on top of
  name, caret, timestamp. We judged the information-density gain
  worth the visual cost; if real-use shows it cluttering, the
  badge can be moved into the disclosure panel as a follow-up.
- The disclosure caret is new UI surface to maintain. Reuses
  ADR-0016's substrate, so the maintenance cost is mostly the
  panel content layout.

**Followups (not blocking).**

- **`@-mention` autocomplete in the composer** should use the same
  format (name + badge) so users picking a recipient see what
  they'll get back. Not part of this ADR; it's a composer change.
- **Channel-member chip UI** (PR #61, already shipped) shows
  agent names today; consider adding the session badge there too
  when ADR-0017 lands. Tracked separately.
- **Click-through on the agent name / badge** to a member-detail
  panel (already on the open follow-up backlog from 2026-05-09)
  becomes more useful with this header — the panel can show full
  config, recent turns under this session, etc.

## Touched files (when implemented)

- `src/lib/components/MessageBubble.svelte` (or whichever file
  owns the bubble header today) — header-line layout, badge
  rendering, disclosure caret.
- `src/lib/components/MessageBubbleHeaderDisclosure.svelte`
  (new) — read-only panel content.
- `src/lib/server/messages.ts` (or equivalent) — record the
  literal session-key string sent on each agent turn so the
  disclosure panel can display it. Existing message-metadata
  shape extended; not a schema migration if the field lands in
  the existing JSON metadata column.
- `docs/decisions/0018-agent-name-in-bubble-header.md` — this file.
- `docs/README.md` — ADR list entry.
- Tests: visual / component tests for the four header cases above.
