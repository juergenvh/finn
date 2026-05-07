# ADR 0003 — ID formats for entities

- **Status:** accepted
- **Date:** 2026-05-07
- **Deciders:** Jürgen, Dixie
- **Supersedes:** —
- **Related:** ADR-0002

## Context

finn's data model has a handful of entity types: agents, channels,
messages, approvals, channel-members. Each row needs an identifier.
Common options for SQLite-backed projects:

- Auto-increment integers (`INTEGER PRIMARY KEY`)
- UUID v4 (random 128-bit, ~36 chars as string)
- UUID v7 (time-ordered, random tail)
- Short prefixed nanoid (`c_8f3a2bd7e1`)

Two pressures shape this decision:

1. **IDs travel out of the database.** Channel ids appear in URLs,
   in WebSocket messages, in OpenClaw session keys
   (`finn:<channel_id>` per ADR-0002), in markdown exports, in PR
   bodies. Long opaque strings hurt every one of those.
2. **IDs travel between people.** When Jürgen says "look at channel
   c_8f3a2bd7e1," that is shorter and more typeable than a full UUID,
   and the prefix tells anyone reading the conversation that the
   thing being referred to is a channel, not an agent.

## Decision

Use **prefixed short nanoid** identifiers for every primary key in
the application schema:

| Entity        | Prefix | Example          |
| ------------- | ------ | ---------------- |
| agents        | `a_`   | `a_8f3a2bd7e1c4` |
| channels      | `c_`   | `c_8f3a2bd7e1c4` |
| messages      | `m_`   | `m_8f3a2bd7e1c4` |
| approvals     | `ap_`  | `ap_8f3a2bd7e1c4`|
| channel_members | (none — composite key) | — |

Format details:

- Prefix is mandatory and stable. Prefixes are part of the contract;
  external systems may parse them.
- The body is **12 characters of nanoid** drawn from the URL-safe
  alphabet (`A-Za-z0-9_-`). 12 chars at this alphabet is ~71 bits of
  entropy, sufficient collision-resistance for a single-tenant tool.
- IDs are generated client-of-DB (i.e. in TypeScript), not by the
  database. Keeps the database honest about being a record store,
  not an identity authority.

## Why nanoid and not UUID

- **Length.** UUID v4 is 36 chars; nanoid-12 with a 2-char prefix is
  14 chars. URLs, headers, and human conversation all benefit.
- **Prefix.** UUIDs have no built-in type discriminator. We could
  prefix anyway, but then we are paying for UUID's length without
  using its standardisation.
- **No claim of standardisation.** finn ids are not exchanged with
  other systems that expect UUIDs. We do not lose interop by picking
  a custom format.

## Why not auto-increment integers

- IDs leak out of the DB (URLs, exports, ADRs). Sequential integers
  reveal record counts and creation order to anyone seeing a URL,
  which we do not want.
- Auto-increment couples ID generation to insertion order, which
  forecloses future patterns like client-side ID generation before
  insert (useful for batched / atomic operations).

## Reserved prefixes

The following prefixes are reserved for current or near-future use.
Do not reuse them for unrelated entities:

```
a_    agents
c_    channels
m_    messages
ap_   approvals
u_    (reserved — users, if/when finn ever becomes multi-user)
s_    (reserved — sessions, if finn introduces its own session table
        separate from OpenClaw session keys)
e_    (reserved — exports, for tracking generated markdown exports)
```

## Consequences

- We need an ID-generation helper. Single source of truth, exported
  from `src/lib/server/db/ids.ts`. The schema files import from
  there; ad-hoc string concatenation is forbidden.
- Tests that need deterministic IDs use a seedable nanoid wrapper or
  fixture data; they do not bypass the helper.
- A migration that changes a prefix is a data-migration ADR, not a
  type change.
- The `finn:<channel_id>` OpenClaw session key (ADR-0002) inherits
  this format: real channel ids will look like `finn:c_8f3a2bd7e1c4`.
