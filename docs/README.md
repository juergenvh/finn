# finn — documentation

This directory holds project documentation that lives longer than a
chat or a daily log. The top-level `README.md` is the front door; the
files here are the source of truth for design decisions, security
posture, setup instructions, and lessons learned.

## Structure

```
docs/
├── README.md              ← this file (index + when-to-write-what)
├── contributing.md        ← branch / PR workflow (ADR-0006)
├── setup.md               ← single-machine setup walkthrough
├── setup-mac.md           ← Mac host + remote VM gateway walkthrough
├── lessons.md             ← things we got wrong and what we changed
└── decisions/             ← Architecture Decision Records (ADRs)
    ├── 0001-openclaw-connector-auth.md
    ├── 0002-session-key-format.md
    ├── 0003-id-formats.md
    ├── 0004-message-persistence.md
    ├── 0005-approval-flow.md
    ├── 0006-pr-only-after-showcase.md
    ├── 0007-crud-ui-architecture.md
    ├── 0008-globalthis-singleton-for-vite-ws-bridge.md
    ├── 0009-log-surface-v1.md
    ├── 0010-protocol-viewer.md
    └── 0011-channel-view-kb-budget.md
```

## Decisions (ADRs)

Numbered, immutable design decisions. Each ADR records:

- **Context** — what problem we faced
- **Options considered** — what we looked at, including rejected ones
- **Decision** — what we chose
- **Consequences** — what this commits us to, what it forecloses

ADRs are append-only. If we change our mind, we write a new ADR that
supersedes the old one rather than rewriting history. The old ADR
stays, marked superseded, so the reasoning trail survives.

Naming: `NNNN-short-slug.md` where `NNNN` is monotonically increasing
across the project (not per-area).

### Index

| #    | Title                                                  | Topic                                                                   |
| ---- | ------------------------------------------------------ | ----------------------------------------------------------------------- |
| 0001 | OpenClaw connector authentication and scope            | how finn talks to a Gateway, what scopes it requests                    |
| 0002 | Session-key format on the OpenClaw connector           | per-channel agent-session continuity                                    |
| 0003 | ID formats for entities                                | prefixed nanoid-12 across all primary keys                              |
| 0004 | Append-only messages, soft-delete elsewhere            | which tables get DELETE, which get `deleted_at`, which neither          |
| 0005 | Approval flow for cross-agent traffic                  | when approvals trigger, sender experience, UI placement                 |
| 0006 | PR-only workflow after first end-to-end showcase       | when direct push stops, what PRs look like                              |
| 0007 | CRUD UI architecture                                   | modal vs route, hardcoded vs schema-driven forms, REST vs WS for writes |
| 0008 | `globalThis` singleton for the active WebSocket server | dev-mode module-instance trap and the smallest fix                      |
| 0009 | Log/transcript surface, v1 scope and shape             | pagination, search, filter, export, and mention-autocomplete choices    |
| 0010 | Protocol viewer architecture                           | separate route, URL-state filters, cursor pagination, audit defaults    |
| 0011 | Initial-load KB budget for the channel view            | bytes (not rows or hours), 200 KB default, when to revisit              |

## Setup guides

| File                | Use when…                                              |
| ------------------- | ------------------------------------------------------ |
| `setup.md`          | finn and OpenClaw run on the same host                 |
| `setup-mac.md`      | finn on macOS, OpenClaw in a UTM VM (two-machine)      |

The two guides are intentionally redundant where they need to be —
pick the one that matches your topology and follow it end to end.

## Lessons

`lessons.md` collects the mistakes worth remembering. Format mirrors
`juergenvh/wintermute/LESSONS.md`: numbered, dated, with what
happened, the symptom, the root cause, and the fix.

Lessons are also append-only.

## When to write what

| Kind of thing                                      | Where it goes                |
| -------------------------------------------------- | ---------------------------- |
| "Why did we pick X over Y?"                        | `decisions/NNNN-*.md`        |
| "How does the auth flow actually work?"            | the ADR is enough; if a user-facing summary is needed, link from `README.md` |
| "How do I run this locally?"                       | `setup.md` / `setup-mac.md`  |
| "We tried X, it broke in production, here's why"  | `lessons.md`                 |
| "What is the structural convention here?"          | inline in the source file's header comment, or in a co-located README (e.g. `src/lib/server/README.md`) |
| Daily exploration / scratch / chat log             | not in this repo             |

If you find yourself explaining the same decision twice in PR bodies
or chat, that's the signal: write an ADR.

## Provenance

This documentation discipline mirrors the pattern used in
`juergenvh/wintermute`, where a central `docs/HALLUCINATIONS.md` and
a `LESSONS.md` proved their worth across many sessions. finn inherits
the same instinct: decisions written down outlive the people who made
them, and stop the next person (or the next session) from
re-litigating settled questions.
