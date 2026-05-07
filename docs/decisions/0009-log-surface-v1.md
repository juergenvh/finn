# ADR 0009 — Log/transcript surface, v1 scope and shape

- **Status:** accepted
- **Date:** 2026-05-07
- **Deciders:** Jürgen, Dixie
- **Supersedes:** —
- **Related:** ADR-0004 (append-only messages), issue #2

## Context

finn is positioned in the README as a "logbook + audit" surface,
but until PR #11 the live tail of one channel was the only way to
read it. Pagination back through history did not exist. Search
did not exist. Export did not exist. The audit log was real on
disk and invisible in the UI.

Issue #2 framed the problem as four candidate workflows (browse,
search, mark, export) with the explicit instruction to ship the
smallest useful subset for v1.

What v1 needs to nail down — even where the answers feel obvious
— is the choice between several plausible alternatives in each
slice, so a future contributor extending this part of the UI
knows which path was rejected and why.

## Decisions

### 1. Pagination shape: 'load older' button, not infinite scroll

The button appears at the scroll-top when older messages exist.
Pressing it fetches the next page (200 by default) older than the
oldest currently displayed message.

#### Alternatives

- **(a) Infinite scroll on scroll-up.** Detect the user reaching
  the top, fire the request automatically.
- **(b) Date jumper.** A small calendar / timestamp picker that
  jumps the view to a specific point in time.
- **(c) Explicit 'load older' button** (chosen).

#### Why (c)

- Infinite scroll-up interacts badly with the auto-scroll-to-
  bottom behaviour we already have. Both code paths would have
  to coordinate around 'is the user actively reading old
  history or watching the live tail?', which adds state and
  edge cases.
- (b) is genuinely useful but only at scale. With a few hundred
  messages a button click is faster than picking a date.
- A button is honest: nothing is fetched until the user asks
  for it. No spurious requests, no scroll surprises.

#### Server-side: preserve user scroll position

When the page prepends older messages, naïve render would jump
the user's scroll position to the new top. Fix: snapshot
`scrollHeight` and `scrollTop` before the prepend, restore
`newScrollHeight - oldScrollHeight + oldScrollTop` after. The
user stays where they were reading.

#### When to revisit

If channels routinely grow past a few thousand messages, the
incremental-fetch model still scales fine; the date jumper (b)
becomes useful for jumping to "what did we discuss last
Wednesday?" without N pagination clicks. Add (b) on top of (c)
without removing (c).

### 2. Search: per-channel, plain LIKE, v1 only

`/api/channels/:id/search?q=` does substring search inside one
channel's message bodies via `LIKE '%q%'`. ASCII case-insensitive.

#### Alternatives

- **(a) SQLite FTS5.** Real ranked full-text search. Requires a
  shadow table and either a migration or a compile-time
  configure step.
- **(b) Substring `LIKE`** (chosen).
- **(c) Cross-channel global search** (deferred).

#### Why (b)

- A single message-bodies column at the volumes finn is built
  for (single-user, low write rate) is fast on `LIKE` for any
  realistic input. Tens of thousands of rows still return in
  milliseconds.
- FTS5 is correct but adds operational weight (shadow table,
  index sync, migration). The right time to take that on is
  when `LIKE` actually feels slow, not before.
- Per-channel is the natural unit because finn channels are
  conversations, not topic categories. Searching "across
  everything" usually means "I forgot which channel" — that
  workflow becomes its own UI feature, not a v1 default.

#### When to revisit

- Search latency observably degrades. Migrate to FTS5, leave
  the route signature intact.
- Users routinely search the same term across channels. Add
  `/api/search?q=` as a sibling, returning hits with a
  channel reference.

### 3. View filters, not persisted server-side

The sidebar's filter checkboxes (sender mute, hide system, hide
rejected) live entirely in the page component's `$state`. They
do not write to the database, do not survive a reload, do not
affect what other tabs see.

#### Alternatives

- **(a) Persist filters per user.** Survive reload, sync
  across tabs.
- **(b) View-only ephemeral filters** (chosen).

#### Why (b)

- Single-user tool; persistence per user is theoretical.
- Filters are exploratory: "let me hide muse for a moment to
  scan dixie's replies". Persisting that across reloads makes
  the next session feel broken until the user re-checks them.
- An explicit 'remember my filters' setting is a sensible v2
  addition; opting in is better than opting out.

#### Why filters at all

Even without persistence, the live-channel UX wins from being
able to silence one agent or hide system messages while
scrolling. The cost is small (a derived list filter), the
benefit shows up immediately.

#### When to revisit

If filters become workflow-defining (e.g. an analyst persona
who routinely starts by muting half the channel), persist them
behind a per-user setting. ADR at that point.

### 4. Export: browser download, not server-side write

The Export button triggers a browser download of the rendered
markdown. The server returns a `Content-Disposition: attachment`
response; the file is saved wherever the browser is configured
to save downloads.

#### Alternatives

- **(a) Server writes to `~/finn-data/exports/`.** No client
  involvement; file appears on the finn host.
- **(b) Browser download** (chosen).
- **(c) Both — server saves AND triggers a download.**

#### Why (b)

- finn often runs on a different machine than the user's
  primary workstation (Mac+VM topology, ADR-0001 addendum).
  In that case (a) writes the export file *on the gateway
  machine*, which is rarely where the user wanted it.
- (b) lands the file wherever the user actually drives.
- (c) is redundant unless the audit story specifically
  requires a server-local copy. It does not today; if it
  does later, add (a) on top of (b).

#### Format

Markdown. One file per channel. Header (id, created, archived,
members), then chronological messages with `### sender ·
timestamp` headings. Approval state inlined as italic notes on
the agent message that triggered it. No filtering: exports are
the full audit, regardless of view-state filters.

#### When to revisit

- "Mark a slice and export only that" becomes a real workflow.
  Range-select-and-export is its own follow-up; the markdown
  format already accommodates partial slices.
- Other formats wanted (PDF, JSON, NotebookLM-friendly). Then
  a `format=` query param grows beyond `md`.

### 5. Mention autocomplete: textarea + manual splice

The mention popup is anchored to the composer's footer; the
underlying input element stays a plain `<textarea>`. Selection
splices `@<name> ` into the textarea value at the right offset
and re-positions the caret.

#### Alternatives

- **(a) `contenteditable` div.** Native cursor handling, mention
  chips. More state, mobile-keyboard surprises.
- **(b) A library** (Tiptap, ProseMirror). Vastly overkill for
  one feature.
- **(c) `<textarea>` + manual splice** (chosen).

#### Why (c)

- One feature; one fragility surface. `textarea` works on
  every browser and platform; mobile keyboards behave;
  copy/paste stays standard.
- Manual splice is a known idiom (`selectionStart`,
  `selectionEnd`, string concat). Easy to reason about,
  easy to test.
- If the composer ever grows other live-syntax features
  (slash commands, channel-mentions, image paste with
  preview), revisit at that point.

### 6. Mention insertion: `@<name>` literal, not id-resolution

The selected mention inserts `@dixie` (the human-readable name),
not `@a_8f3a2bd7e1c4` (the id) and not a Markdown link.

#### Alternatives

- **(a) `@<agent_id>`.** Unambiguous if names collide.
- **(b) `@<name>`** (chosen).
- **(c) Markdown link `[@dixie](agent:a_xxx)` that renders as
  the name.** Requires rich rendering (#1, parked).

#### Why (b)

- Names are how the user thinks about agents. The id is
  implementation detail.
- The server-side mention parser already resolves names per
  channel, so `@<name>` works end-to-end without any new
  protocol.
- Name collisions are a smaller problem than id-leakage. If
  two agents share a name in the same channel, the user has
  a worse problem than mention-resolution: ambiguous
  routing.

#### When to revisit

When rich rendering lands (the discovery in #1), the chip
form (c) becomes possible without losing readability. Until
then, plain `@<name>` is the right balance.

## Out of scope for this ADR

These are tracked as follow-ups under issue #2 (or as separate
issues):

- Cross-channel search.
- FTS5 ranked search.
- Range-select mark-and-export.
- Date-jumper / calendar pagination.
- Persisted user filter preferences.
- Server-side `~/finn-data/exports/` write.
- `#channel` autocomplete.

## Consequences

- The audit story remains read-only at the UI level: nothing
  in this slice can edit, hide, or remove a stored row.
  Filters are view-state only, exports are byte-for-byte from
  the messages table.
- The `messages` route now has a richer query surface
  (`limit`, `before`); future additions (e.g. `since`) compose
  cleanly.
- The export format becomes a public-ish artefact: anything we
  break in the markdown layout is visible in saved files.
  Format changes should be additive (new sections at the end)
  rather than reshaping past content.
- Mention rendering is committed to plain text until rich
  rendering decides otherwise (#1).
