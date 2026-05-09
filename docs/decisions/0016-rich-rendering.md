# ADR 0016 — Rich rendering for message bubbles

- **Status:** accepted
- **Date:** 2026-05-09
- **Deciders:** Jürgen, Dixie
- **Related:** Issue #1 (discovery), ADR-0001 (connector trust
  model), ADR-0013 (streaming + scroll discipline), issue #43
  (token footer consistency).

## Context

Bubbles render `{body}` plain inside a `white-space: pre-wrap`
monospace block. No markdown parsing, no sanitizing, no
highlighting. The pattern was deliberate during the spike — text
fidelity beats interpretation when the wire shape is still moving.

The wire shape has settled (ADR-0013 phases 1–3 + sweep), and a
real symptom exists: agents already produce markdown unprompted.
Sample reply pulled from the local DB on 2026-05-09:

> ```
> Eingetragen unter `USER.md → Preferences`: **Lieblingsfarbe: blau** 🔵
> ```

Backticks, bold, emoji — rendered as literal characters today.
Issue #1 was the discovery ticket asking whether and how to fix
this; this ADR captures the decisions that came out of that
discovery.

## Decisions

### 1. Scope: legibility, not chat-client polish

The goal is option (a) from the issue body: make existing
markdown legible. **Not** option (b) "make finn feel like a real
chat client". Code highlighting, latex, embedded media, link
unfurls — all explicitly out of scope for this ADR. They are
each their own decision, deferred until a real user need
surfaces.

Minimum useful set:

- bold, italic, strikethrough
- inline code (`code`)
- fenced code blocks (no syntax highlight; just visual block
  treatment in monospace)
- inline links
- ordered and unordered lists
- blockquotes
- headings (`#`–`######`)
- GFM tables (free with the parser; no extra cost)
- soft line breaks (single newline → `<br>`)

That covers everything we have empirical evidence for in the DB
plus the obvious near-neighbours.

### 2. Uniform rendering for both user and agent bubbles

User bubbles get the same rich-rendering treatment as agent
bubbles. System messages stay plain — they are finn-authored,
no markdown to interpret.

Two reasons (raised by Jürgen 2026-05-09):

- Users copy-paste content too. JSON, command output, docs
  excerpts — that content carries markdown. Rendering user
  bubbles plain while rendering agent bubbles rich would make
  the same string look different depending on who pasted it.
- The safety control is the **sanitizer**, not the source.
  Same DOMPurify pass applies in both cases; if a user pastes
  `<script>`-flavoured markdown, the sanitizer drops it the
  same way it would for an agent reply.

### 3. Trust model: sanitizer-gated, source-uniform

Per ADR-0001, finn trusts the operator-configured connector
endpoints. That trust does **not** extend to rendering arbitrary
HTML. The renderer pipeline is:

```
markdown source
  → marked.parse(markdown, { breaks: true, gfm: true })
  → DOMPurify.sanitize(html, ALLOWLIST)
  → mention post-process (DOM walk)
  → {@html result}
```

DOMPurify policy:

- **Default profile**, with these explicit denials documented
  for clarity (most are default-on but pinning makes the
  contract auditable):
  - `<script>`, `<iframe>`, `<object>`, `<embed>`
  - All inline event handlers (`onclick`, `onload`, etc.)
  - `javascript:` URLs in `href`
  - `data:` URLs in `href` (default DOMPurify allows
    `data:image/*` but we don't render images today; revisit
    when image embedding becomes a feature)
- `<a target>`: stripped (links open in-place; revisit if
  user feedback wants `_blank`).
- All other defaults stand.

System messages: stay on the existing plain-text path. They are
finn's voice; there's no markdown to interpret and no need to
round-trip them through a parser.

### 4. Code blocks: monospace, no highlight (phase 1)

Inline `code` and fenced ``` ``` ``` blocks render with:

- existing monospace stack (already in the bubble body CSS)
- a slightly different background for visual block treatment
- subtle border / padding for fenced blocks
- `white-space: pre` inside `<pre><code>` so internal newlines
  are preserved verbatim (the renderer strips outer
  `pre-wrap`; code blocks need their own whitespace
  semantics)

**No syntax highlighter.** Reasoning:

- Highlighter libraries are the heaviest dep in the rich-
  rendering space (`shiki` ~2 MB with grammars, `highlight.js`
  ~600 KB, `prism` ~50 KB minimal but per-language). All three
  outweigh the markdown parser itself.
- Most code in our channels is short — shell snippets, JSON
  responses, diff hunks. Monospace + clear visual block
  treatment covers the legibility goal.
- Highlighting deserves its own ADR (bundle weight, language
  list, theme matching the dark UI). Doing it as a follow-up
  PR keeps phase 1 small.

If/when a highlighter lands, candidates: **shiki** (best
quality, biggest), **prism** (smallest, decent quality). Out
of scope today.

### 5. Mentions: post-process the rendered HTML

Server-side mention resolution stays in `mentions.ts` for the
approval flow. Rendering is **client-only**:

After sanitize, walk the DOM looking for text nodes containing
`@<token>` patterns. For each match, if the token resolves
against the current channel's member set, replace it with a
`<span class="mention">` carrying the agent name. If it
doesn't resolve, leave the text alone.

Two important rules:

- **Skip text inside `<code>` and `<pre>`.** Mentions inside
  code blocks are literals (a path, a username in a config
  example), not actual mentions.
- **Skip text inside existing links.** A mention rendered
  inside a markdown link `[...]` retains the link, no nested
  rewrite.

Visual treatment:

- subtle accent colour matching the existing mention-popup
  style in the composer
- no underline
- hover state for affordance
- click behaviour: nothing in phase 1; later (probably
  alongside #18-adjacent member-detail work) opens a member
  panel.

### 6. Whitespace semantics: GFM with `breaks: true`

`marked` standard mode collapses single newlines (HTML-style).
Chat needs them as soft breaks (line A then line B on
separate visual rows). `marked`'s `breaks: true` option does
exactly that: single newline → `<br>`, double newline →
paragraph break. GFM also gives tables and strikethrough.

The bubble's outer `white-space: pre-wrap` comes off; the
renderer owns whitespace from then on. Code blocks get
`white-space: pre` internally so their formatting survives.

### 7. Library choice: `marked` + `DOMPurify`

| Option           | Bundle (gz) | API                                            | Reason                            |
| ---------------- | ----------- | ---------------------------------------------- | --------------------------------- |
| `marked`         | ~30 KB      | sync, simple, small extension API              | **picked** — fits the scope       |
| `markdown-it`    | ~70 KB      | richer plugin ecosystem                        | overkill for our scope            |
| `micromark` +    |             |                                                |                                   |
|   `mdast`        | ~50–100 KB  | tree-based, future-proof for AST manipulation  | adds an unneeded layer            |
| `remark`         | ~80+ KB     | full ecosystem, plugin-heavy                   | weight + complexity               |

`DOMPurify` ~20 KB, the standard. No real alternative worth
considering for browser-side HTML sanitization.

Total bundle add: ~50 KB gzipped. Acceptable for the value.

### 8. Auto-scroll discipline: ResizeObserver

The current scroll effect tracks `messagesByChannel.length` and
`tail.body.length` ([+page.svelte added in #42]). It does not
re-run when:

- `approvalsByMessage` mutates (late `approval_created` after
  `message_end`).
- a bubble's body switches from streaming-plaintext to
  finalised markdown render (no length change in
  `messagesByChannel`, but the rendered output may be visibly
  taller — code blocks, tables, blockquotes).

Both cases produce the same symptom: scroll lands at "bottom of
the streamed body", not "bottom of the fully-rendered bubble".
The forward-picker scroll fix in #54 patched a third instance
of the same race.

**Decision:** replace the per-event scroll-on-mutation with a
**`ResizeObserver`** on the messages-container's scroll
element. When `scrollHeight` grows AND the user is at-or-near
the bottom (threshold ~50 px), snap to the new bottom. The
threshold prevents fighting the user when they deliberately
scrolled up to read history.

This catches everything that mutates layout — body deltas,
late-arriving approval buttons, markdown finalisation, image
loads, font swaps — through one observer. Single source of
truth, hard to forget a trigger.

The existing per-event scroll trigger comes off; ResizeObserver
takes over.

### 9. Footer always-on for agent bubbles

Per the comment thread on #1, the token footer's current
"render only when tokens != null" rule produces inconsistent
visuals (OpenClaw bubbles have a footer strip, Wintermute
bubbles don't). When this ADR's PR reshapes the bubble layout
anyway, the footer becomes:

- **Always on** for agent bubbles.
- Renders `tokens: —` (em-dash) when the upstream did not
  surface usage.
- Tooltip explains why on hover: "backend reports no usage"
  for backends that don't (Wintermute, anthropic-stub).
- Stays hidden during streaming (usage arrives at
  `message_end`; showing 0/0 earlier would mislead).

User and system bubbles still have no footer. The footer
remains an agent-bubble feature; this ADR makes it consistent
*within* that scope.

This is the bubble layout's first commitment to a stable
two-strip shape (header + footer); future per-message
metadata (model, latency, relay path) plug into the footer
alongside tokens.

## Phasing

This ADR is one PR's worth of scope. The implementation lands
as a single PR because the four threads — markdown rendering,
mention post-process, ResizeObserver scroll, always-on footer
— all touch `MessageBubble.svelte` and `+page.svelte`'s scroll
effect. Splitting them would introduce intermediate states
where the bubble is half-reshaped.

Out-of-scope follow-ups (each its own future ADR + PR):

- Syntax highlighting in code blocks.
- Click-through on `@-mention` spans (member detail).
- Embedded media (images, video, attachments).
- Latex / mathjax.
- A "view raw markdown" debug toggle.

## Touched files (anticipated)

- `package.json` — add `marked` + `dompurify`.
- `src/lib/ui/MessageBubble.svelte` — render pipeline; remove
  `pre-wrap`; code-block CSS; footer always-on logic.
- `src/lib/ui/markdown.ts` (new) — wraps the
  `marked` + `DOMPurify` + mention-post-process pipeline so
  the same code path renders user and agent bodies.
- `src/routes/+page.svelte` — replace per-event scroll
  effect with ResizeObserver hookup; pass member list into
  the markdown pipeline for mention resolution.
- `docs/connectors.md` — note that bubble bodies render
  markdown.

## Consequences

- finn now interprets bytes coming from connectors (and from
  the user). The trust posture (ADR-0001) is unchanged on the
  network/auth side; the new rendering interpretation is
  bounded by DOMPurify. The threat model gets one new entry:
  "compromised connector emits crafted markdown that survives
  sanitization and produces unwanted UX". Mitigation: the
  default DOMPurify allowlist plus the explicit denials in §3.
- The bubble's outer `white-space: pre-wrap` comes off.
  Pre-rich-rendering plain-text bodies that relied on it for
  multi-newline preservation now go through the markdown
  parser, which collapses lone newlines unless `breaks: true`
  is on (it is). Existing channel history will re-render after
  the change; expected to look better, but worth eyeballing
  on first deploy.
- Every bubble now goes through ~50 KB of gzipped JS at first
  paint. Loaded once per page; not in the per-message hot
  path beyond the parse call itself (which is O(body length)
  and runs in a few ms even for long bodies).
- The `ResizeObserver` decision retires three separate
  scroll-trigger sites that all hit the same race. Future
  layout-altering features (member detail panel, latency
  badge, etc.) inherit correct scroll discipline by default.
- The footer becomes a stable layout fixture for agent
  bubbles. Adding new per-message metadata fields no longer
  needs a "should this widget be visible" decision — it
  plugs into the existing always-on strip.
