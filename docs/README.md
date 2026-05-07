# finn — documentation

This directory holds project documentation that lives longer than a
chat or a daily log. The top-level `README.md` is the front door; the
files here are the source of truth for design decisions, security
posture, and lessons learned.

## Structure

```
docs/
├── README.md            ← this file
├── decisions/           ← Architecture Decision Records (ADRs)
│   └── 0001-*.md
├── trust-model.md       ← detailed security model + threat model
└── lessons.md           ← things we got wrong and what we changed
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

## When to write what

| Kind of thing                                      | Where it goes                |
| -------------------------------------------------- | ---------------------------- |
| "Why did we pick X over Y?"                        | `decisions/NNNN-*.md`        |
| "How does the auth flow actually work?"            | `trust-model.md` (or sibling) |
| "We tried X, it broke in production, here's why"  | `lessons.md`                 |
| "How do I run this locally?"                       | top-level `README.md`        |
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
