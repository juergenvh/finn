# ADR-0027 — Markdown composer for chat input

**Date:** 2026-06-12  
**Status:** Accepted  
**Closes:** issue #105 (partial), PR #177

## Context

The plain `<textarea>` with Enter-to-send worked but offered no
formatting affordances. Two options were evaluated:

**Option A — `carta-md`** (source editor): textarea with Markdown
syntax highlighting + Write/Preview tabs. Lightweight, Svelte-native.
Tried in PRs #170–#176. Abandoned after ~8 hours of fighting:
- `default.css` sets `height: 600px` on the input
- JS sets inline `min-height: 64px` after mount (overrides `!important`)
- Tab-toggle buttons use an undocumented class name (`.carta-toolbar-left`, not `.carta-tabs`)
- Two borders (Carta's wrapper + ours) required persistent CSS battles

**Option B — TipTap** (WYSIWYG): types bold and sees bold. Heavier,
ProseMirror-based, needs a markdown-output extension. Not evaluated yet.

**Option C — custom (chosen):** Plain textarea + 4 toolbar buttons
that insert markdown syntax. 60 lines, zero library, one border.

## Decision

`MarkdownComposer.svelte` — plain `<textarea>` with:
- Bold (`**`), Italic (`_`), Code (`` ` ``), Link (`[text](url)`) buttons
- Buttons wrap selected text or insert placeholder
- Keyboard shortcuts: Ctrl+B, Ctrl+I, Ctrl+E
- Buttons float above the textarea border as accent-coloured badges
- Auto-expand up to 10 rem; Enter=send, Shift+Enter=newline
- `onkeydown` forwarded to parent for `@mention` popup navigation

## Consequences

- One border, no library fights.
- Preview: users see rendered output when the message appears as a bubble.
  This is "preview on send" not "WYSIWYG while typing".
- TipTap (true WYSIWYG) remains an option for a future pass when the UX
  decision is confirmed.
- carta-md and @cartamd/plugin-slash removed from dependencies.
