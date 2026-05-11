# ADR 0019 — Settings surface: global defaults + per-channel overrides

- **Status:** proposed
- **Date:** 2026-05-11
- **Deciders:** Jürgen, Dixie
- **Related:** Issue #18 (this discovery), Issue #13 (KB-budget
  motivator), Issue #28 (per-channel auto-approve — direct
  consumer), ADR-0007 (CRUD = modal, NOT followed here — see
  *Alternatives*), ADR-0015 (auto-approve channels — depends on
  this ADR landing first).

## Context

Several finn behaviours have configurable knobs that today live
as in-code constants. The triggering case is the channel-view
KB-budget for initial load (`INITIAL_BUDGET_KB = 200` in
`src/routes/+page.svelte`, ADR-0011). To change it, edit the
file and rebuild.

The phase-2 ticket pipeline makes this a near-term blocker:

- **#13 / ADR-0011** itself argued the budget should eventually
  be configurable, both globally and per-channel.
- **#28 / ADR-0015** (per-channel auto-approve toggle) is the
  next phase-2 ticket and it *needs* per-channel runtime
  configuration. Without a settings surface there is nowhere
  for the toggle to live.
- A handful of view-state preferences (`show groomed`, `hide
  system messages`, default channel on open, theme) are today
  either browser-`localStorage` or simply not persisted, and
  should be reconciled in the same pass.

This ADR is the discovery #18 asks for: it pins **where**
settings live, **which** of them are per-channel vs global,
**how** they are presented in the UI, and **what** the
persistence shape looks like. It does *not* implement them; a
follow-up PR migrates the KB-budget as the first real consumer
and stands up the route skeleton.

## Decision

Four answers to the four open questions from #18.

### 1. Where do settings live → DB-backed + env-var split

- **Runtime user settings:** DB-backed, in a typed table.
  Survives reload, syncs across tabs (via the same WS bridge
  every other mutation goes through), no file in
  `~/finn-data/` that the operator could edit at odds with
  what the UI shows.
- **Deployment parameters:** env-var only (gateway base URL,
  PORT, listener host, etc.). These are operator-side, set at
  boot, never edited from the UI.
- **`config.json` in `~/finn-data/` is rejected.** Two
  sources-of-truth (file + DB) is exactly the inconsistency
  trap that bit the project around message persistence
  before. Single source per category.

### 2. Which settings are global vs per-channel

Decided per-setting now, so the discovery actually closes:

| Setting                                | Global | Per-channel | Notes                                                              |
| -------------------------------------- | :----: | :---------: | ------------------------------------------------------------------ |
| Initial-load KB budget (#13 / ADR-0011) |  yes   |     yes     | Global default; per-channel override when set. **First migration.** |
| Auto-approve agent-to-agent (#28 / ADR-0015) |  no   |     yes     | Per-channel only by design — the audit-modal context is channel-scoped. |
| `Show groomed` default (#15)           |  yes   |     no      | View-state otherwise; only the *default at load* is a setting.    |
| `Hide system messages` default         |  yes   |     no      | Same shape as #15.                                                 |
| Default channel on open                |  yes   |    n/a      | Single value, last-active otherwise.                              |
| Theme / colours                        |  yes   |     no      | Cosmetic, browser-level concern, persists in DB so it survives device swaps. |
| Approval-default targets               |   —    |      —      | **Out of scope of this ADR.** Belongs in ADR-0005 follow-up if it becomes a setting at all. |

**Precedence rule** when both a global and a channel-scoped
value exist for the same key: **channel overrides global, global
overrides hardcoded default**. Missing channel row → fall through
to global. Missing global row → fall through to compiled
constant.

### 3. UI placement → dedicated `/settings` route

A new top-level route, not a modal.

This deliberately diverges from **ADR-0007** (which chose modal
over route for CRUD). Reasons:

- ADR-0007's frame was a *single transactional editor of a
  single record* (channel definition, agent definition).
  Settings is *multiple read-rarely-edited surfaces* (global
  section + N per-channel sections + theme).
- Settings is read-heavy and write-rare. Modals are oriented
  toward write-then-dismiss; a `/settings` route is oriented
  toward browse-then-tweak.
- Linkability matters: a doc, an error message, or a `@-mention`
  reply can deep-link to `/settings#kb-budget`. A modal cannot.
- The route does not violate ADR-0006 (PR-only) — that ADR is
  about merge discipline, not UI topology.

Layout:

- `/settings` lands on a global-settings page (KB budget,
  defaults, theme).
- Left rail lists channels; clicking a channel switches the
  main pane to that channel's per-channel settings (KB-budget
  override, auto-approve toggle).
- Channel-header gets a small **shortcut affordance** (gear
  icon, opens `/settings/<channel>`) — discoverability at the
  point of need, plus central place to manage.

### 4. Persistence shape → two typed Drizzle tables

```ts
// src/lib/server/db/schema.ts (sketch — exact column names TBD in PR)

export const settingsGlobal = sqliteTable('settings_global', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kbBudgetDefault: integer('kb_budget_default').notNull().default(200),
  showGroomedDefault: integer('show_groomed_default', { mode: 'boolean' }).notNull().default(false),
  hideSystemMessagesDefault: integer('hide_system_messages_default', { mode: 'boolean' }).notNull().default(false),
  defaultChannelId: text('default_channel_id'),
  theme: text('theme').notNull().default('system'), // 'system' | 'light' | 'dark'
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const settingsChannel = sqliteTable('settings_channel', {
  channelId: text('channel_id').primaryKey().references(() => channels.id, { onDelete: 'cascade' }),
  kbBudgetOverride: integer('kb_budget_override'), // null = inherit global
  autoApprove: integer('auto_approve', { mode: 'boolean' }).notNull().default(false),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});
```

**Singleton row for `settings_global`** — there is one row, period
(enforce in code via upsert on `id=1`). Migrations add columns
when a new global setting lands; that's explicit, reviewable,
and a one-line Drizzle change.

**One `settings_channel` row per channel that has at least one
override.** Channels without a row inherit global on every key.
Cascade on channel delete keeps it tidy without orphan rows.

**Why typed columns over key/value:**

- finn's settings set is small and curated. The "I might add 50
  settings someday" worry is hypothetical; the "I need
  validation, types, and a discoverable schema today" is real.
- Drizzle migrations are cheap. The cost of one migration per
  new setting is far below the cost of runtime validation logic
  + type-narrowing every read site.
- The schema *is* the documentation. A new contributor reads
  `schema.ts` and sees the actual set of knobs.

## Alternatives considered

### key/value table (`settings(scope, key, value)`)

Rejected. Loses validation, loses TypeScript narrowing on read,
forces runtime parsing (`JSON.parse(value)` everywhere), and the
"flexible for future settings" pitch is exactly the wrong
trade-off for a curated single-user app. The flexibility tax
is paid every read; the alleged future benefit is a migration
saved.

### `config.json` in `~/finn-data/`

Rejected. Two sources of truth. Operator-side edits and
UI-side edits will diverge. The single-user-web-app frame
doesn't need the file-edit affordance — `/settings` covers it.

### Modal-from-sidebar (ADR-0007 consistency)

Considered, rejected. Settings is fundamentally multi-section
and read-heavy; the modal pattern from ADR-0007 was scoped to
single-record CRUD. Forcing settings into a modal would
either need tabs-in-modal (ugly) or multiple modals (worse).
Deep-linkability would also be lost.

### Inline-only (gear next to each control)

Considered, rejected as the *primary* surface. Inline is great
for discoverability but scatters the truth — a user who wants
to know "what are my current overrides" has nowhere to look.
The route is the canonical surface; the channel-header gear is
a shortcut *into* the route, not a replacement.

### Env-var only for everything

Rejected. Env-var requires a restart. Settings are user-facing
runtime preferences. Mismatch of cadence.

## Implementation plan (this ADR ships zero code)

This ADR is documentation-only. Code follows in separate PRs.

**PR 1 — schema + read API + `/settings` skeleton:**

- Migration: create `settings_global` (with the singleton seed)
  and `settings_channel`.
- Server: `GET /api/settings` returns global merged with the
  requested channel override (or global only if no
  `?channelId=` query).
- Route: `/settings` skeleton with the left rail and the global
  pane, no editing yet (read-only display proves the wire).
- Acceptance: `curl /api/settings` returns the seeded defaults;
  `/settings` renders them.

**PR 2 — write API + KB-budget migration:**

- Server: `PATCH /api/settings` (global) and `PATCH
  /api/settings/channel/:id`. WS broadcast on change so open
  tabs reconcile.
- Client: `INITIAL_BUDGET_KB = 200` deleted from `+page.svelte`;
  channel view reads global → channel override → fallback `200`
  in that order.
- Acceptance: change the global budget in `/settings`, reload
  the channel, observe the new budget applied. Set a
  per-channel override, observe it wins.

**PR 3 — remaining global toggles + theme + channel-header gear:**

- Client: show-groomed default, hide-system-messages default,
  default-channel-on-open, theme selector all editable.
- Channel header: gear icon → `/settings/<channelId>`.
- Acceptance: all listed settings toggle via UI, persist across
  reload, broadcast across tabs.

The per-channel **auto-approve** toggle is deliberately *not* in
this plan — it ships under ADR-0015 / Issue #28 and depends on
this ADR's `settings_channel.autoApprove` column existing. The
column is created in PR 1; ADR-0015's PRs wire the UI and
agent-side enforcement.

## Consequences

### Positive

- Phase-2's biggest dependency (`#28` toggle wants somewhere to
  live) is unblocked.
- `INITIAL_BUDGET_KB = 200` stops being a recompile-to-change
  constant.
- A canonical surface for "what are my preferences" emerges
  before more knobs accumulate ad-hoc.

### Negative

- Adds a new top-level route, slight UX surface increase.
- Migration discipline for every new global setting (acceptable
  cost, see *Why typed columns over key/value*).
- Diverges from ADR-0007's modal-default — the divergence is
  argued above but it is one more pattern to remember.

### Neutral / follow-ups

- Approval-default-targets question is intentionally deferred;
  if it becomes a setting it lands in a future ADR that engages
  with ADR-0005.
- Multi-user (#46) will likely need a `user_id` scope on
  `settings_global`. Today's single-user MVP makes it a
  singleton; the migration to per-user is a straightforward
  schema change later.

## Open questions for review

1. **Theme persistence in DB vs `localStorage`?** I argued DB
   (survives device swaps, syncs across tabs). The cost is one
   round-trip per page-load to determine theme — a flash of
   wrong theme is possible. Acceptable, or push it back into
   `localStorage`?
2. **Channel-header gear icon — too noisy?** It's per-channel
   discoverability but eats header real-estate. Acceptable, or
   keep `/settings` as the only entry point?
3. **Is the `settings_global` singleton-row pattern too cute?**
   Alternative: no table, store globals as a `JSON` column on a
   `meta` table that already exists, or in app config loaded
   at boot. I prefer the explicit singleton row for
   queryability and the migration trail it leaves; happy to
   walk back if you'd rather not.
