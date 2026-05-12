# ADR 0022 — Mermaid diagram rendering in message bubbles

- **Status:** accepted
- **Date:** 2026-05-12
- **Deciders:** Jürgen, Dixie (concept developed in a multi-agent
  design session with Wintermute and Gwen on 2026-05-11; see
  ADR-0021 process notes)
- **Related:** ADR-0016 (rich rendering — deferred Mermaid),
  ADR-0001 (connector trust model — informs the three-layer
  sanitizer posture), ADR-0013 (streaming + scroll discipline —
  informs the streaming/`message_end` switch), ADR-0021 (the
  multi-agent initiation pattern that produced this concept),
  issue #80.

## Context

ADR-0016 (rich rendering for message bubbles) explicitly deferred
Mermaid diagram rendering as an out-of-scope follow-up.
Bubbles today render `language=mermaid` fenced blocks as plain
monospace code blocks. Goal: render them as actual diagrams.
Same legibility argument that drove ADR-0016, applied to the
next class of content agents already produce unprompted.

The concept was developed end-to-end in a 4-hop multi-agent
design session on 2026-05-11 (Dixie / Wintermute / Gwen, see
ADR-0021's process record). Issue #80 captures the full
discussion output. This ADR is the design pinning, ready for
implementation.

## Decision

### Pipeline

Fenced code block with `language=mermaid` is intercepted in
`src/lib/ui/markdown.ts` before the standard code-block path
and delegated to a new `MermaidBlock.svelte` component. Rest of
the bubble continues through `marked` + DOMPurify unchanged.

The interception happens at the markdown parser level rather
than post-render so that the standard sanitizer pipeline never
sees the mermaid source as HTML — it stays as a payload string
delivered to the renderer component.

### Security: three layers, defense-in-depth

The threat model: a connector emits markdown containing a
`mermaid` block with crafted node labels (e.g.,
`<img onerror=...>`). Mermaid internally assigns SVG via
`innerHTML`, so any payload that survives to that point is a
problem.

1. **Pre-parse layer.** Escape `<`, `>`, `&` inside Mermaid
   source labels before calling `mermaid.parse()`. This is the
   cheapest layer and catches naive payloads before any Mermaid
   code runs.
2. **Mermaid-internal layer.** Configure Mermaid with
   `securityLevel: 'strict'`. This enables Mermaid's own
   DOMPurify pass and disables `htmlLabels`, which closes the
   `<foreignObject>`-with-HTML vector.
3. **Post-render layer.** Run a second DOMPurify pass over the
   rendered SVG subtree with an explicit SVG allowlist (tags:
   `svg, g, path, rect, circle, ellipse, line, polyline,
   polygon, text, tspan, defs, marker, use, foreignObject` —
   the last only because Mermaid still emits it for some
   non-HTML cases). This protects against future Mermaid
   versions weakening strict mode.

The three layers are independently auditable, and any one of
them failing still leaves the other two as backstops. Per
ADR-0001's connector trust model: connector content is
untrusted by construction; sanitization is the boundary.

### Conscious UX tradeoff: no text wrapping in node labels

`securityLevel: 'strict'` disables `htmlLabels`. Mermaid falls
back to `<text>` instead of `<foreignObject>` for label
rendering, which means **no text wrapping inside node labels**.
Long labels overflow the node visually.

Phase 1 accepts this. Phase 2 may revisit (a tighter
`'loose'`-level config plus our own post-render sanitizer) if
real users complain about long labels. The current trade is:
visual cosmetics for a strictly smaller attack surface.

### Theming

- A `MediaQueryList` listener on `(prefers-color-scheme: dark)`
  re-renders all visible Mermaid blocks on change.
- The in-memory SVG cache is keyed on `(source, theme,
  mermaidVersion)`. The version component invalidates the cache
  automatically on a Mermaid library upgrade — the same source
  can render differently across versions, and a stale cache
  would hide regressions.

### Sizing

```css
.mermaid-rendered svg { max-width: 100%; height: auto; }
.mermaid-rendered { overflow-x: auto; }
```

`max-width` (not `width`) so small diagrams aren't upscaled.
`overflow-x` lives on the container, not the SVG itself —
overriding `width` while leaving `height: auto` can collapse
very wide flowcharts to a few pixels tall.

### Streaming (consistent with ADR-0013)

While `streaming === true`, the Mermaid block renders as the
current monospace code block. Rationale: mid-stream Mermaid
source is almost always unparseable; parsing on every token
update would flicker between error-state and
(possibly) parsed-state.

On `message_end`, switch from code-block to Mermaid render.
The switch gets a **150 ms CSS fade transition** to avoid a
visible bubble-height jump when a flowchart turns out to be
much taller than the code block was.

### Fallback on parse error

Render as monospace code block with a small inline error
message. No empty bubble, no crash. This is the same render
path used during streaming, so the failure mode is visually
consistent with "still loading" — the user sees the source
either way, just with a small "could not render" indicator
when finn knows it failed.

### Performance

- **Bundle.** Mermaid full package (~500 KB gzipped), loaded
  via `dynamic import('mermaid')` on first `MermaidBlock` mount.
  Per-diagram-type splitting (`@mermaid-js/mermaid-flowchart`,
  `-sequence`, etc.) is not worth the complexity at our scope;
  reconsider if bundle size becomes a real user-visible cost.
- **Multiple diagrams in one bubble.** Render sequentially
  (`for...of` + `await`), with `requestIdleCallback` between
  renders to keep the main thread responsive. `setTimeout(fn, 0)`
  fallback for older Safari (`requestIdleCallback` shipped in
  Safari 17.4).
- **In-memory SVG cache** keyed on `(source, theme,
  mermaidVersion)`. No `localStorage` — bubble state is rebuilt
  from DB on page load anyway, and persistent caching would
  outlive a Mermaid version bump in unwanted ways.

## State machine impact

None. Mermaid is a pure render concern; messages still flow
through `recordAgentMessage` / `recordUserMessage` as plain
markdown and the database has no knowledge of which fenced
blocks happen to be mermaid.

## Persistence

No schema change. The mermaid source is stored as the body of
the message row, exactly as it arrives from the connector.

## Wire protocol additions

None. Existing `message_start` / `message_delta` /
`message_end` lifecycle (ADR-0013) is sufficient: the client
flips its rendering mode on `message_end`.

## Implementation phasing

Single PR. The scope is large enough that splitting would
produce intermediate states with worse UX than today (e.g.
"mermaid renders but without the sanitizer pass" is not
shippable, "mermaid renders without theming" looks broken in
dark mode). Land as a unit.

Anticipated files touched:

- `package.json` — add `mermaid` dependency
- `src/lib/ui/markdown.ts` — intercept `language=mermaid` blocks
- `src/lib/ui/MermaidBlock.svelte` — new component (renderer,
  cache, theme listener, fallback render)
- `docs/decisions/0022-mermaid-rendering.md` — this file
- `docs/connectors.md` — note Mermaid is rendered when fenced
  as `mermaid` so connector authors know the contract

Optional follow-up (separate PR):

- `tests/smoke/` — a playwright spec that opens a fixture
  channel with one mermaid-bearing message and asserts the SVG
  rendered. Lesson #12 applies (curl + check don't cover the
  bind layer); the smoke spec is the right gate for this.

## Out of scope (future ADRs)

- **Click-to-zoom / lightbox modal** for diagrams. Useful once
  diagrams are common; not phase 1.
- **PlantUML, D2, other diagram languages.** Same pattern would
  apply but each needs its own evaluation. Mermaid first
  because it's overwhelmingly what agents emit today.
- **Server-side pre-rendering of Mermaid.** Would change the
  bundle story significantly and adds a server-side dependency;
  reconsider only if client-side bundle weight becomes a
  measured problem.
- **Mermaid in system messages.** System messages stay plain
  per ADR-0016. No reason to change that for diagrams either.
- **"View raw mermaid" debug toggle.** Useful for debugging
  parse failures; the fallback-render already exposes the
  source when the diagram fails, which covers the most common
  case.
- **Image rendering in bubbles** (the second half of Jürgen's
  request on 2026-05-12 evening, "bilder und mermaid"). The
  threat model and UX questions for images (where do the bytes
  live? what URL schemes? size limits? thumbnail vs full?) are
  substantively different from Mermaid's and deserve their own
  ADR. Recorded here so the parallel ask isn't lost.

## Consequences

- ADR-0016's deferred Mermaid promise is now redeemed.
- finn ships its first runtime-loaded heavy dependency
  (~500 KB Mermaid). The dynamic-import path means the channel
  view stays fast for users who never see a mermaid block. If
  this becomes a precedent for other lazy-loaded renderers
  (PlantUML, charting libraries), the pattern (`MermaidBlock`-
  style component + dynamic import + in-memory cache) is
  reusable.
- Connector authors gain a new render contract: fenced blocks
  with language `mermaid` will be rendered as diagrams, not as
  raw code. This is documented in `docs/connectors.md` so it's
  not a surprise.
- The three-layer sanitizer pattern (pre-escape, library-
  internal strict mode, post-render allowlist) is a reusable
  posture for future "render-untrusted-content-as-DOM" work
  beyond Mermaid.

## Open questions deferred to implementation

- **Exact SVG allowlist** for the post-render DOMPurify pass.
  The list in the Security section is a starting point;
  empirical testing against Mermaid's real output (flowcharts,
  sequence diagrams, gantt, state, class) may add or remove
  entries. The implementation PR pins the final list.
- **Cache eviction policy.** Pure-LRU on the in-memory cache,
  or unbounded for a session? Probably unbounded is fine for
  v1 — typical session sees tens of unique diagrams, not
  thousands. Revisit if memory becomes an issue.
- **Fade-transition implementation.** `<Transition>` from
  Svelte's built-ins, or a manual CSS-class swap? Probably the
  latter is simpler; implementer's call during the PR.
