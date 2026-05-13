# ADR 0023 — Image rendering in message bubbles

- **Status:** discovery
- **Date:** 2026-05-13
- **Deciders:** Jürgen, Dixie
- **Related:** ADR-0022 (mermaid rendering — companion piece;
  this ADR follows the same pattern for the structural shape
  but the threat model is materially different), ADR-0016
  (rich rendering — the deferred-images note is what this
  ADR redeems), ADR-0001 (connector trust model — agent
  output is untrusted by construction; sanitisation is the
  boundary), issue #101.

## Context

ADR-0022 redeemed the mermaid half of Jürgen's
"bilder und mermaid" request from 2026-05-12. Images were
deliberately split off because the threat model and UX surface
are substantively different from diagram rendering:

- A `<img src>` tag loads bytes from an arbitrary origin the
  moment the bubble renders, ships `Referer` and `User-Agent`
  to that origin, and exposes the user's IP. Mermaid is a
  pure client-side render; images are a third-party network
  fetch.
- The "code path that produces visible output" for images
  starts at the connector and ends in the user's browser
  with **no sanitiser between the URL and the GET**. DOMPurify
  controls the markup; it doesn't control the bytes the
  browser fetches.
- The byte source is open-ended: HTTPS URLs, `data:` URLs,
  server-side stores all exist as design points with
  different storage, performance, and privacy implications.

Today: agents that emit `![alt](https://example.com/cat.png)`
get the markdown rendered as a literal `<a>` link (because
`<img>` isn't on the DOMPurify allowlist and `data:` is
explicitly stripped from `href`). Goal: render the image,
without opening tracking-pixel / phishing / mixed-content
holes that the current "block everything" posture protects
against.

This ADR walks issue #101's seven open questions, proposes
v1 pinned answers with rationale, and flags the questions
where multi-agent or external input would tighten the answer.

## Decision (proposed)

### 1. Byte source: HTTPS URLs only for v1

`![alt](https://...)` markdown only. No `data:` URLs inline,
no server-side image store, no upload from the composer.

**Rationale.** Smallest defensible footprint that delivers the
user-visible feature. The other two options are real ADRs of
their own:

- **`data:` URLs inline.** Self-contained but bloats the DB
  row size; ADR-0011 (KB budget) accounting would have to
  count image bytes. Realistic agent output already produces
  these (e.g., chart libraries), so this *will* come up as
  a follow-up. **Deferred.**
- **Server-side image store.** Most flexible (private agents
  can post bytes that finn re-serves), biggest build (storage,
  GC, auth, URL signing). Genuinely useful only when v1 is
  insufficient — premature otherwise. **Deferred.**

v1 = HTTPS URLs. The pipeline below is designed so that
adding `data:` or a server-store later is an additive
allowlist change, not a re-architecture.

**Connector-side reality check (2026-05-13).** Wintermute is
moving to Anthropic Haiku 4.5 as the upstream model. Haiku
4.5 is not an image-output model: Wintermute's reply stream
will not contain generated image bytes, only markdown
references to existing HTTPS URLs (GitHub user-content,
docs assets, screenshot URLs that the agent already has in
its tool surface). This grounds the v1 scope: the
overwhelmingly common case in the next quarter is
`![alt](https://...)`, exactly what v1 supports. The
`data:`-URL and server-store paths stay deferred without
cost.

### 2. URL scheme allowlist

Allowed: `https://`.

Blocked: everything else.

- `http://` — blocked. Mixed-content warnings in production
  hurt the trust posture even when finn-the-tool is
  http-served itself. Connector authors can switch to HTTPS
  for image hosts; it's 2026.
- `data:image/*` — blocked in v1. Re-enabled when the data-URL
  ADR ships (see §1).
- `file://`, `javascript:`, `blob:`, `about:` — blocked,
  obvious.

Enforcement: a DOMPurify `uponSanitizeAttribute` hook on
`<img src>` that rejects anything not starting with
`https://`. The hook lives next to the existing `data:` href
stripping in `markdown.ts`.

### 3. Size / dimension limits

- CSS: `max-width: 100%; height: auto;` on the rendered
  `<img>`. Same posture as mermaid SVGs from ADR-0022.
- HTML: `loading="lazy"` on every rendered `<img>` so
  off-screen bubbles don't fan out network requests on
  channel load.
- No byte-size limit at render time. The browser is already
  bounded by its own image decoder limits, and finn doesn't
  proxy the fetch. If users hit "bubble loads 200 MB PNG and
  freezes the tab", we revisit — but the failure mode is
  visible and the user controls which channels they open.
- No automatic downscale. Browser handles display sizing via
  `max-width`. Source bytes are the source's problem.

### 4. Failure mode

Failed image (404, CSP block, scheme mismatch, network
error): render the markdown literal `![alt](url)` as
monospace text with a small inline error caption. Same
fallback shape as ADR-0022's mermaid render-failure path.

Implementation: an `onerror` handler on the rendered `<img>`
replaces the node with a `<span class="image-error">` carrying
the literal markdown text. The handler is **not** an inline
HTML attribute (DOMPurify would strip it); it's attached
post-sanitize during the same DOM walk that mounts mermaid
placeholders (ADR-0022's `mountMermaidBlocks` pattern,
extended).

### 5. Threat model

Three vectors, three mitigations:

1. **Loaded-on-render tracking.** Every rendered `<img>`
   fetches its bytes from a third-party origin and ships
   `Referer`. **Mitigation:** `referrerpolicy="no-referrer"`
   on every rendered `<img>`. Cheap, well-supported, removes
   the leak entirely.

2. **Phishing / disclosure via injected `<img>`.** Agent or
   user emits crafted markdown that injects an image
   referencing a credential-flavoured URL (e.g., a "click
   here to verify" tracking image). The HTTPS-only scheme
   filter blocks `javascript:` etc., but the legitimate
   `https://` channel itself is open.
   **Mitigation:** explicit DOMPurify attribute allowlist
   for `<img>`: `src`, `alt`, `title` only. No `srcset`,
   `usemap`, `crossorigin`, `style`, `width`, `height` as
   attributes (width via CSS only). No event handlers
   (already blocked by DOMPurify defaults, pinned here for
   audit).

3. **Content Security Policy as a second layer.** Today's
   finn ships no CSP header. Image rendering is a reasonable
   forcing function for one: `default-src 'self'` plus
   `img-src https:` would be the v1 starting point.
   **Decision:** CSP is its own follow-up — adding a
   Response header touches every server-render path and
   needs its own audit (inline styles, websocket origins,
   etc.). Image rendering ships **without** CSP in v1; the
   sanitiser allowlist plus scheme filter is the boundary.
   Tracked as a separate issue after this ADR lands.

### 6. Sizing / theming

- Sizing rules from §3 (no theming concern).
- No dark/light variant; `<picture>` is out of scope.
- Click-to-zoom / lightbox: out of scope for v1, same call
  as mermaid.

### 7. Streaming

Render as soon as the markdown token completes (i.e., on
`message_end` like the rest of the markdown pipeline today).
A mid-stream half-image would fall through to the regular
plain-while-streaming text path. **No special-case**: image
markdown is just markdown, and the existing
plain-while-streaming → finalised-on-end discipline from
ADR-0013 + ADR-0016 already handles it correctly. No
`MermaidBlock`-style deferred mount needed.

This is the simplest of the seven answers, and the one
that means the implementation is structurally smaller
than ADR-0022's.

## Pipeline summary

```
agent emits: ![alt](https://example.com/cat.png)
  -> marked (default markdown rendering produces <img src alt>)
  -> DOMPurify
       - ALLOWED_TAGS includes <img>
       - ALLOWED_ATTR for <img> = ['src', 'alt', 'title']
       - uponSanitizeAttribute hook: drop src if not https://
  -> postProcessImages(root): for each <img>, add
       - loading="lazy"
       - referrerpolicy="no-referrer"
       - onerror handler (replaces node with literal-markdown
         span on load failure)
  -> {@html ...} into bubble body
```

No new module needed. The image-rendering logic adds:

- ~8 lines to `markdown.ts` (allowlist + hook + post-process
  helper)
- ~25 lines of CSS to `MessageBubble.svelte`
- 4–6 unit tests in `tests/unit/markdown-images.test.ts`

vs ADR-0022's 320-line `mermaid.ts`. Image rendering is
materially less code because there's no library to load, no
post-render sanitiser pass (the `<img>` tag itself is the
render — there's no SVG subtree to allowlist), no theme
listener, no cache.

## State machine impact

None. Markdown source travels as-is in the message body row;
the database has no knowledge of which markdown happens to
contain an image reference.

## Persistence

No schema change.

## Wire protocol additions

None. Existing markdown rendering on `message_end` is
sufficient.

## Implementation phasing

Single PR. The scope is small enough (one file, ~50 LOC of
production code) that splitting would produce intermediate
states with no benefit. Land as a unit.

Anticipated files touched:

- `src/lib/ui/markdown.ts` — allow `<img>`, scheme filter,
  post-process helper
- `src/lib/ui/MessageBubble.svelte` — CSS for `.body-rich img`
  and `.image-error` fallback
- `docs/decisions/0023-image-rendering.md` — this file
- `docs/connectors.md` — note image rendering contract
  (HTTPS only, markdown syntax)
- `tests/unit/markdown-images.test.ts` — renderer unit tests

## Out of scope (future ADRs)

- **`data:` URL inline images.** Real demand once chart-emitting
  agents arrive. Will need ADR-0011 (KB budget) interplay.
- **Server-side image store.** Agents POST bytes, finn re-serves.
  Useful for private content and image generation. Substantially
  bigger build (storage layout, GC, auth, URL signing).
- **Image upload from the composer.** Today's request is agent
  output rendering. User-side image send is a connector and
  storage question, not a render question.
- **Click-to-zoom / lightbox modal.** Same call as mermaid.
- **CSP headers.** Reasonable forcing function but its own audit
  surface. Separate issue post-merge.
- **Hostname allowlist for `<img src>`.** Possible v2 hardening
  if users hit phishing-ish behaviour from agent output. v1
  trusts HTTPS as the boundary.
- **`<picture>`, `srcset`, responsive variants.** Render fidelity
  improvement; not safety. Out of scope.
- **Animated GIFs / `<video>`.** Static images first; motion
  has its own UX concerns (autoplay, sound).
- **Image generation prompts** (user asks an agent for a PNG,
  agent generates one). Agent-side capability, not a finn
  render concern.

## Consequences

- ADR-0016's deferred-images comment in `markdown.ts` becomes
  redeemable; the explanatory note about "we don't render
  images today" gets updated to point at this ADR.
- Connector authors gain a new contract: HTTPS image URLs
  in markdown render as actual images, with no-referrer
  policy and lazy loading. Documented in `docs/connectors.md`.
- finn's sanitiser posture shifts from "block all images" to
  "allow HTTPS images with a constrained attribute surface".
  The audit footprint is one DOMPurify hook plus an allowlist
  diff; small, reviewable.
- The three-layer sanitiser pattern from ADR-0022 does **not**
  apply here. Images don't need a post-render allowlist —
  there's no subtree to walk, the `<img>` tag itself is the
  render. This is one of the differences that justifies
  splitting #101 from #80 in the first place.
- A future CSP header becomes a natural next step. This ADR
  explicitly defers that to its own ticket so it gets the
  audit it deserves.

## Open questions for review

Marked here so the multi-agent / Jürgen-side review pass can
land tightly on the load-bearing decisions before code:

1. **Confirm `https://`-only is the right v1 boundary.** Are
   there real agent scenarios in the next 30 days where
   `http://` or `data:` is the only available source? If yes,
   that argues for at least the `data:` path landing
   alongside v1.

   **Update 2026-05-13:** Wintermute is moving to Haiku 4.5
   (no image-generation capability). Confirms `https://` URLs
   as the dominant near-term case. Question stands open in
   case other connectors (anthropic-stub fixtures, openai-
   compatible upstreams with vision-output models) change
   the picture.

2. **Confirm "no CSP in v1" is acceptable.** The argument
   for: smaller PR, separate audit. The argument against:
   the moment images render, the next pen-test will flag the
   missing CSP header.

3. **Confirm no hostname allowlist in v1.** Trusting all
   HTTPS hosts is the simplest, broadest contract. A
   hostname allowlist is also the most user-hostile
   tightening (agents emit images from CDNs, GitHub
   user-content, etc., that the user wouldn't have thought
   to allow). Probably "trust HTTPS, observe, iterate" is
   right.

4. **Confirm the failure-mode UX.** The proposed fallback
   shows the literal markdown text on broken images.
   Alternative: show a small generic "broken image"
   placeholder icon (consistent with browser default,
   uncluttered). Which is more useful when reviewing the
   protocol later?

5. **Status of this ADR after review.** If the four
   questions above resolve unchanged, this ADR can flip
   from `discovery` to `accepted` and implementation
   proceeds as a single PR. If any of them changes the
   shape (e.g., `data:` URLs in scope), the ADR gets
   updated before implementation.

If a multi-agent review pass is wanted, Gwen's UX/security
instincts and Wintermute's "what do real agents actually
emit?" instincts are the relevant inputs (see issue #101's
suggested process). My read is that the design space is
well-walked already and a solo review by Jürgen is
sufficient — but the multi-agent option remains open and
would also serve as a second confirmation case for ADR-0021
(promoting it from discovery to accepted).
