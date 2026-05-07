# ADR 0010 — Protocol viewer architecture

- **Status:** accepted
- **Date:** 2026-05-07
- **Deciders:** Jürgen, Dixie
- **Supersedes:** —
- **Related:** ADR-0004 (append-only + grooming addendum),
  ADR-0009 (log-surface v1), issue #14

## Context

ADR-0009 shipped the v1 log surface inside the channel view —
backwards pagination, per-channel search, view filters,
single-channel export. After that landed, real-world use
exposed a structural mismatch: the channel view is a
*conversation* surface (recent context, ephemeral filters,
grooming controls) while audit reading is a fundamentally
different shape (cross-channel, historical, comprehensive).

Issue #14 separated the two: the channel view stays
conversation-scoped; a new \`/protocol\` route is the audit
surface.

This ADR pins the design choices that shape that separation.

## Decisions

### 1. Separate route, not a tab switcher or modal

The protocol viewer lives at \`/protocol\`, with its own page,
its own sidebar, its own URL. The main channel view at \`/\`
gains a single navigation link to it.

#### Alternatives

- **(a) Tab switcher** at the top of the main UI (Channels |
  Protocol) sharing the sidebar.
- **(b) Modal / slideover** that takes over the main pane while
  the sidebar stays.
- **(c) Dedicated route** (chosen).

#### Why (c)

- The protocol viewer's filter surface is large enough (search,
  channel multi-select, sender filters, date range, visibility,
  approval state, plus pagination controls) that it deserves
  its own sidebar shape. Reusing the channel sidebar would
  either crowd it permanently or require a complete swap when
  switching modes.
- A separate URL means deep-linking just works: filter into a
  specific cross-channel slice, copy the URL, share or bookmark.
- Tab switcher (a) is a future-friendly *layout* refactor on
  top of (c) — moving from "two routes" to "one route with a
  switcher" is a UI change, not a data-model change. Locking in
  (c) does not foreclose (a).

#### When to revisit

If a third audit-style surface appears (e.g. a statistics
dashboard) that wants the same filter controls, the unifying
move is a tab-switcher layout that hosts all of them. At that
point (a) becomes the right answer.

### 2. URL search-params as filter source-of-truth

All filter controls reflect into the URL via
\`history.replaceState\`. Page-load reads the URL and seeds the
controls. Every "Apply" or "Clear" updates both the local
state and the URL.

#### Alternatives

- **(a) Local-only state**, no URL sync. Filters reset on
  reload.
- **(b) Sticky local state via \`localStorage\`**. Survives
  reload but not portable.
- **(c) URL search-params** (chosen).

#### Why (c)

- Audit reading is a *task*, not a session. "Show me
  everything dixie said in salon between Monday and
  Wednesday" deserves to be a copy-paste-able link.
- Reload-doesn't-lose-filters is a quality-of-life win that
  comes free with URL sync.
- No new persistence layer, no settings table for filter
  defaults; the URL bar is the storage.

#### Limits

The URL gets long when many channels or agents are filter-
selected. SQLite-LIKE patterns and nanoid ids are short, so we
remain comfortably below typical URL-length limits in practice
(a few KB across all browsers). A future pathological case is
a separate problem.

### 3. Cursor-based pagination, not offset

The protocol viewer paginates with an opaque cursor encoded
from \`(created_at, id)\`. The 'Load more' button passes the
last response's \`next_cursor\` back to the server.

#### Alternatives

- **(a) Offset/limit** (\`page=N\`). Simple. Breaks under
  concurrent inserts (rows can shift between pages).
- **(b) Time-only cursor** (\`before=<ms>\`). Works when
  timestamps are unique; risky when two messages share a
  millisecond.
- **(c) Composite cursor** \`(created_at, id)\` with strict
  lexicographic ordering (chosen).

#### Why (c)

- Stable: a row that was on page N stays on page N even if
  newer rows arrive between fetches.
- Linear cost, no offset-creep on large tables.
- Composite avoids the millisecond-tie risk.
- Already proven in the channel view's 'load older' button
  (which uses a simpler timestamp form because per-channel
  collisions are rare; the protocol viewer is cross-channel
  and more likely to hit ties).

#### Why opaque

The cursor is a server-internal contract. Clients should not
construct cursors by hand; they treat the value as a token to
echo back. This leaves room for future cursor formats (FTS5
ranking score plus timestamp, for example) without protocol
versioning.

### 4. Visibility default: 'all', not 'visible_only'

The visibility selector defaults to \`all\` — groomed messages
appear by default in the protocol viewer.

#### Alternatives

- **(a) Default 'visible_only'**, mirror the channel view.
- **(b) Default 'all'** (chosen).

#### Why (b)

- The point of the protocol viewer is the audit. Hiding
  groomed messages by default contradicts that.
- The user can narrow with a single click if they want only
  the visible-channel-view subset.
- Matches the markdown export, which already includes groomed
  messages — different defaults between viewer and export
  would surprise.

### 5. 'Only rejected approvals' is a flag, not a filter combo

Showing only messages whose approval was rejected is a single
checkbox, not a derived view of "sender_type=agent + approval
status filter".

#### Alternatives

- **(a)** Treat approval status as a filter dimension on its
  own, with values \`pending | approved | routed | rejected\`.
- **(b)** Single 'only rejected' flag (chosen).

#### Why (b)

- Rejected is the audit-interesting status. Pending is
  transient; approved/routed are normal flow. Foregrounding
  rejected as a one-click control matches the actual
  workflow ("show me everything I rejected") without
  cluttering the sidebar with a four-state radio group.
- If pending-or-routed-only ever becomes a real workflow,
  promote (b) to (a) at that point.

### 6. Markdown export: walk-all, not page-bound

The export endpoint walks pages until the cursor exhausts (or
a hard cap of 50,000 rows triggers), regardless of the
viewer's current pagination state.

#### Alternatives

- **(a)** Export only what's currently on the page.
- **(b)** Export everything matching the current filters
  (chosen).

#### Why (b)

- "Export the current view" reads as "export this filtered
  slice", not "export this page". A user filtering for "all
  rejected approvals across all channels" wants every match,
  not the first 200.
- Hard cap of 50,000 keeps an accidental whole-database export
  bounded.

### 7. Channel pill on each hit links back to the channel view

Each result row's channel name renders as a clickable pill
that navigates to \`/?channel=<id>\` (note: the channel-id-as-
URL-param at \`/\` is itself a small cross-cutting feature; the
pill assumes it works).

#### Alternatives

- Plain channel-name text, no link.

#### Why a link

- The natural follow-on action after finding an interesting
  row in the audit is "show me that conversation". A click
  shortens the path from "I found it" to "I'm reading it".
- The pill itself is small enough not to dominate the result
  layout.

#### Caveat

The \`?channel=<id>\` query-param handler on the main page is
a separate small piece of work that is not yet wired
(the link will land on the default channel for now). Worth
adding alongside or as a small follow-up; tracked as a TODO
in the channel-view component.

## Refactor done along the way

The single-channel export silently filtered out groomed
messages before this PR. ADR-0004 says exports are
audit-faithful, so that was a bug. Fixed by switching the
single-channel export to \`scope='all'\` and extracting a pure
\`renderMessagesAsMarkdown\` helper that both surfaces use.

## Consequences

- The audit surface is a separate URL. Bookmarkable filters,
  shareable views.
- The export contract is "the markdown represents the current
  filter, not the current page".
- Cursor-based pagination is the project's pattern for
  potentially-long lists. The channel view's 'Load older' is
  simpler today (timestamp-only \`before\`) and could migrate
  to the composite form if collisions ever cause skipping.
- Future audit-style surfaces (statistics, log dashboards)
  can either be siblings to \`/protocol\` or trigger the
  tab-switcher refactor under decision 1.
