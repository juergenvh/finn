# ADR 0002 — Session-key format on the OpenClaw connector

- **Status:** accepted
- **Date:** 2026-05-07
- **Deciders:** Jürgen, Dixie
- **Supersedes:** —
- **Related:** ADR-0001

## Context

OpenClaw's `/v1/chat/completions` endpoint is **stateless per request**
by default — every incoming call is a fresh agent session unless the
caller pins a session via either the OpenAI `user` field or the
`x-openclaw-session-key` HTTP header.

In practice this means: when finn relays a user turn into the OpenClaw
connector, the agent on the far side sees a brand-new session every
time. With agents that load context-heavy memory at session start (the
default agent on this VM is `dixie`, which reads four memory sections
in parallel before responding to the first message), every relayed
chat turn re-pays that startup cost. The user sees latency, the
agent sees a torn conversation, and a long chat in finn looks like a
sequence of unrelated greetings to the agent.

We want each finn channel to map to one stable agent session, so a
multi-turn conversation in finn looks like one continuous conversation
to the agent.

## Options considered

### Option A — OpenAI `user` field

Pass `user: "finn:<channel_id>"` in the chat-completions request body;
let OpenClaw derive a stable session key from it.

**Pros:** uses a standard OpenAI-API field; works against any
OpenAI-compatible endpoint.
**Cons:** opaque to anyone reading OpenClaw logs (the derived key is
implementation-defined); ties our session identity to whatever
hashing OpenClaw applies, which we do not control; conflates "user
identity" (the OpenAI semantic of `user`) with "session identity"
(what we actually want).

### Option B — `x-openclaw-session-key` header, finn-controlled

Pass `x-openclaw-session-key: finn:<channel_id>` directly. finn
chooses the literal key.

**Pros:** explicit; readable in OpenClaw logs and audit trails; not
an implementation-derived hash; the `finn:` prefix marks origin
unambiguously, which helps when reasoning about an agent's session
list ("which sessions came from finn vs the TUI vs hooks?").
**Cons:** OpenClaw-specific header — does not transfer to a
hypothetical other OpenAI-compatible target without translation.
Connector contract leaks into the wire format.

### Option C — Per-message random key

Generate a fresh session key per message.

**Pros:** trivially correct stateless semantics.
**Cons:** defeats the purpose. This is essentially what we have today
and want to fix.

**Rejected.**

## Decision

**Option B.** finn sends `x-openclaw-session-key: finn:<channel_id>`
on every OpenClaw connector request.

The "OpenClaw-specific header" downside of Option B is acceptable
because:

1. The OpenClaw connector is, by definition, OpenClaw-specific. It is
   not a generic OpenAI client. Other connectors (Anthropic,
   future OpenAI-direct) will not use this header and will manage
   their own conversation continuity differently.
2. Readability of session keys in OpenClaw audit logs has more value
   than wire-protocol portability that we will never exercise.

## Key format

```
finn:<channel_id>
```

- `finn:` — literal prefix, identifies origin.
- `<channel_id>` — the channel identifier as stored in finn's own
  channel table (post-DB) or hardcoded for the spike (`spike` today).

Example: `finn:spike`, later `finn:c-7f3a8e2d`.

## Multi-instance considerations

If finn ever runs in multiple instances simultaneously against the
same OpenClaw gateway (e.g. dev finn and prod finn on the same
machine, or finn-on-VM and finn-on-Mac sharing a gateway), naïve
`finn:<channel_id>` keys would collide.

We are **not solving that today.** The MVP is a single finn instance.
When the multi-instance case becomes real, the format extends to
`finn:<instance_id>:<channel_id>`, and the `instance_id` lives
either in finn's own config (per-deployment static value) or is
derived from a stable host identifier. That migration is additive —
existing single-instance keys can remain valid by treating absence of
the second segment as `instance_id=default`.

## Consequences

- The OpenClaw connector always threads
  `x-openclaw-session-key: finn:<channel_id>` on every call.
- finn channel identifiers must be safe for use in HTTP header values
  and stable across the channel's lifetime (renaming a channel must
  not change its id; the human-visible name is stored separately).
- An OpenClaw operator looking at active sessions can identify finn-
  initiated sessions by their `finn:` prefix.
- Once the database is in (ADR pending), channel ids will be opaque
  short identifiers (e.g. `c-7f3a8e2d`), generated server-side, not
  derived from the channel name. ADR-0003 (channel id format) when
  we get there.

## Hardcoded today, real tomorrow

Until the DB is in (next session), the spike uses the literal channel
id `spike` everywhere. The connector still threads the header,
which today resolves to `finn:spike`. When the DB lands, the wiring
already works; only the source of `channel_id` changes.
