# ADR 0011 — Initial-load KB budget for the channel view

- **Status:** accepted
- **Date:** 2026-05-07
- **Deciders:** Jürgen, Dixie
- **Supersedes:** —
- **Related:** ADR-0009 (log-surface v1), ADR-0010 (protocol
  viewer), issue #13

## Context

ADR-0009 made the channel view respect a 'load older' button
for backwards pagination. The default initial load was 200
messages, with a comment that long-running channels would still
greet the user with too much scroll on open.

Issue #13 framed the question: a four-month-old chat does not
want to dump four months of history at the user the moment they
click the channel. The channel view is a *conversation* surface,
not an archive. Older history stays reachable via 'Load older'
and (now) via the protocol viewer at \`/protocol\` (ADR-0010).

This ADR pins what unit the cap uses, what value it has today,
and when to revisit.

## Decision

The channel view's initial load is capped on **cumulative body
size in kilobytes**, not on row count or time window. Default:
**200 KB**.

The server-side helper \`recentMessagesByBudget\` walks newest-
to-oldest, accumulating \`length(body)\`, and stops when the
next row would push the running total over the budget. Always
includes at least one row, so a single oversized message still
surfaces rather than producing an empty view.

The route \`GET /api/channels/:id/messages?budget=<kb>\` activates
this mode. \`limit=\` and \`before=\` continue to work unchanged
for 'Load older' pagination. \`budget\` and \`before\` are mutually
exclusive — if both are sent, \`before\` wins (paginating older
history is a deliberate user action).

## Why bytes, not rows or hours

| Unit          | Failure mode |
| ------------- | ------------ |
| Last N rows   | One short reply ≠ one 5 KB code dump. \"Last 200\" can be 4 KB or 400 KB. |
| Last N hours  | A quiet day ≠ a noisy hour. \"Last 24h\" can be 0 messages or 50 MB. |
| Last N bytes  | Tracks how much the eye actually scans on open. Stable across channel patterns. |

Bytes is the unit that survives both ends of the spectrum.

## Why 200 KB

The first iteration shipped with 64 KB and was raised to 200 KB
during testing the same day. 200 KB lands roughly:

- enough for a chatty channel to surface a meaningful slice of
  recent context (a few dozen agent replies and user turns)
- not enough for a long-running channel to dump everything
- well below typical browser-render-blocking thresholds

The number is pragmatic, not derived. Real-world tuning will
likely want per-user and per-channel overrides (issue #18,
settings surface).

## Alternatives considered

### (a) No cap, full history

Today's behaviour pre-PR. Rejected because the channel view is
a conversation surface; the protocol viewer is the audit
surface. Different jobs.

### (b) Last N rows

Considered as the simpler implementation. Rejected for the
'short reply ≠ 5 KB code dump' reason above. The variance is
too wide to feel right at any single N.

### (c) Last N hours

Considered for the time-aware feel. Rejected for the same
reason in the other direction: variance is too wide.

### (d) Bytes (chosen)

The actual unit that bounds 'how much of the channel does the
user have to scroll past on open'.

## Consequences

- The channel view is now bound by what the user reads, not
  by what the channel contains. A long-quiet channel shows
  the full context anyway because it fits; a long-active one
  trims to the recent slice.
- 'Load older' still works the same. The budget mode does
  not change pagination semantics.
- The server's \`has_more\` flag drives the channel view's
  \`reachedStart\` map authoritatively, replacing the previous
  '<200 returned' heuristic.
- The constant lives in \`+page.svelte\` for now. Issue #18
  (settings surface) is the right place to put per-user
  / per-channel tuning when it arrives; the cross-reference
  is in the source comment.

## When to revisit

- The settings surface (issue #18) lands. Move the constant
  to the settings table; default stays 200 KB; users can
  adjust globally and per-channel if the discovery decides
  that.
- Real-world usage shows the default consistently feels too
  tight or too loose. Adjust the default first; introduce
  the per-channel knob if the variance is real, not
  preference.
- Bodies become non-trivial in size (image attachments,
  encoded blobs). Then byte-counting on body alone stops
  reflecting render cost; revisit the unit. Today messages
  are pure text and the equivalence holds.

## Out of scope

- Rendering-aware budgeting (e.g. counting embedded image
  bytes differently). No images today.
- 'Continue where I left off' read-position resume. Different
  feature.
- Per-channel custom budgets without a settings UI. Deferred
  to issue #18.
