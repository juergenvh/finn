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
├── connectors.md          ← provider scenarios (Anthropic, local Ollama, stub)
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
    ├── 0011-channel-view-kb-budget.md
    ├── 0012-agent-aware-session-key.md
    ├── 0013-streaming-and-sequencing.md
    ├── 0014-user-triggered-forwarding.md
    ├── 0015-auto-approve-channels.md
    ├── 0016-rich-rendering.md
    ├── 0017-agent-bound-session-override.md
    ├── 0018-agent-name-in-bubble-header.md
    ├── 0019-settings-surface.md
    ├── 0020-roundtrip-cap.md
    ├── 0021-multi-agent-channel-initiation.md
    ├── 0022-mermaid-rendering.md
    └── 0023-image-rendering.md
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
| 0012 | Agent-aware session-key format                         | encode the agent into the session-key so multi-agent routing actually works |
| 0013 | Token-streaming + reply-sequencing                     | three-event lifecycle (start/delta/end), parallel async iteration in dispatcher, plain-while-streaming render. Accepted; phases 1–3 + sweep all shipped. |
| 0014 | User-triggered forwarding                              | second legitimate routing form alongside `@-mention` approvals: ↗ on a bubble forwards verbatim to channel members, lands directly in `routed` status, no `pending` stage. ADR-0005's no-auto-approve invariant unchanged. |
| 0015 | Auto-approve channels: topology, audit, loop defences  | per-channel opt-in to skip the approval gate. finn surfaces facts (channel-member audit modal, mechanical duplicate flags, role labels from optional capability probes) and lets the user decide. Loop defences (roundtrip cap, NO_REPLY first-class, concurrent-stream ceiling) built in. |
| 0016 | Rich rendering for message bubbles                     | markdown bodies (`marked` + `DOMPurify`, GFM + soft breaks), uniform for user and agent bubbles, no syntax highlighter in phase 1, mention post-process, ResizeObserver scroll discipline, always-on footer. Issue #1. |
| 0017 | Agent-bound session override                           | optional `session_override` field on the OpenClaw connector config. Pins an agent to a named upstream session (e.g. `finn`, `sagesmith`) regardless of which finn channel it's used in. Multi-session = multi-agent-row, by design. **Accepted, shipped via #65 + #66.** |
| 0018 | Agent name in message-bubble header                    | bubble header shows agent name + optional session badge (only when ADR-0017 override is set) + disclosure caret for connector / session-key debugging info. Default behaviour unchanged for agents without override. **Accepted, shipped via #67 + #68 (members-endpoint fix).** |
| 0019 | Settings surface: global defaults + per-channel overrides | `/settings` route with two-pane shape (global form + per-channel list). Effective values resolve per-key with explicit precedence, `null` clears an override. Initial keys: KB budget, auto-approve, roundtrip cap, default-channel-id. **Accepted, shipped via #71 + #72 + #73 + #74 + #75.** |
| 0020 | Per-channel roundtrip cap                              | hard ceiling on hop count per user-turn-window to bound runaway multi-agent loops. Pre-consumed at dispatch, audit-row emitted on cap-trip with empty `targets[]` and a system-event note. ADR-0015 §5a is what this ships. **Accepted, shipped via #76.** |
| 0021 | Multi-agent channel initiation patterns                | four structural elements for producing convergent multi-agent design output: setup-prompt (mode + topology + constraint), anstoss-prompt (topic + output + quality forcing functions), explicit hop-1 role distribution, roundtrip cap as quality constraint. Discovery ADR; four implementation options sketched, current vote is Option B (per-channel `initiation_template` field). Promote on second confirming session. **Status: discovery.** |
| 0022 | Mermaid diagram rendering in message bubbles           | fenced `mermaid` blocks render as SVG diagrams in agent and user bubbles. Three-layer sanitiser (pre-escape label content, `securityLevel: 'strict'` with `htmlLabels: false`, post-render DOMPurify with explicit SVG allowlist). Lazy-loaded mermaid bundle, in-memory cache keyed `(source, theme, version)`. Plain-while-streaming, finalised on `message_end` with 150 ms fade. Issue #80. **Accepted, shipped via #102.** |
| 0023 | Image rendering in message bubbles                     | `![alt](https://...)` markdown renders as actual `<img>` in agent and user bubbles. Two-layer defense: DOMPurify scheme filter (HTTPS only) and attribute allowlist (`src`, `alt`, `title`); plus `referrerpolicy="no-referrer"` and `loading="lazy"` injected post-sanitize. Failure mode: literal markdown text + small error caption. CSP and composer paste/upload deliberately deferred to their own ADRs (#105, #106). Issue #101. **Accepted 2026-05-13; implementation PR to follow.** |
| 0024 | Drop the test-era connector system prompt              | remove the hardcoded `SYSTEM_PROMPT` ("...the user is testing channel plumbing") from the `openclaw` and `openai-compatible` connectors. finn is a router, not a persona authority; agent runtimes own their own system prompt end to end. Matches the existing `anthropic-stub` shape. No configurable router-side context replacement in this ADR (deferred to its own future feature). **Accepted, shipped via this PR.** |

## Setup guides

| File                | Use when…                                              |
| ------------------- | ------------------------------------------------------ |
| `setup.md`          | finn and OpenClaw run on the same host                 |
| `setup-mac.md`      | finn on macOS, OpenClaw in a UTM VM (two-machine)      |
| `connectors.md`     | picking a provider (Anthropic Cloud, local Ollama, …) and wiring it through the OpenClaw connector |

The setup guides are intentionally redundant where they need to be —
pick the one that matches your topology. `connectors.md` is
orthogonal: read it after one of the setup guides to choose what
your agents actually talk to.

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
