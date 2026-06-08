# Warp.dev-Style UI Refresh — Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Transform finn's visual design into a sleek, modern dark UI inspired by warp.dev — deeper blacks, subtle violet accents, glassmorphism, rounded surfaces, and refined typography.

**Architecture:** Replace hardcoded hex values with a CSS custom-property system defined in `app.css`. Update all major surfaces (channel view, message bubbles, modals, forms, protocol viewer, settings) to consume the variable palette. Add Inter font via Google Fonts. Keep the existing Svelte 5 runes and component structure intact — this is purely a visual layer change.

**Tech Stack:** SvelteKit 5, plain CSS (no Tailwind), CSS custom properties, Google Fonts (Inter).

---

## Task 1: Establish CSS Custom Property Foundation

**Objective:** Create a centralized design-token system in `app.css` and wire it into `app.html` with Inter font.

**Files:**
- Modify: `src/app.css`
- Modify: `src/app.html`

**Step 1: Add Inter font import to `app.html`**

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
```

**Step 2: Rewrite `app.css` with CSS custom properties**

Replace the entire file with a token system. Key values:

```css
:root {
  /* Backgrounds — deeper than current #0e0e10 */
  --finn-bg-base: #09090b;
  --finn-bg-elevated: #121214;
  --finn-bg-surface: #18181b;
  --finn-bg-input: #0f0f11;
  --finn-bg-hover: #1c1c1f;
  --finn-bg-active: #27272a;

  /* Borders — almost invisible, using alpha */
  --finn-border: rgba(255, 255, 255, 0.06);
  --finn-border-hover: rgba(255, 255, 255, 0.1);
  --finn-border-focus: rgba(167, 139, 250, 0.4);

  /* Text */
  --finn-text-primary: #fafafa;
  --finn-text-secondary: #a1a1aa;
  --finn-text-muted: #71717a;
  --finn-text-disabled: #52525b;

  /* Accent — violet family, warp.dev inspired */
  --finn-accent: #8b5cf6;
  --finn-accent-hover: #a78bfa;
  --finn-accent-soft: rgba(139, 92, 246, 0.12);
  --finn-accent-glow: rgba(139, 92, 246, 0.25);

  /* Semantic */
  --finn-success: #34d399;
  --finn-error: #f87171;
  --finn-error-bg: rgba(248, 113, 113, 0.08);
  --finn-warning: #fbbf24;

  /* Shadows */
  --finn-shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.3);
  --finn-shadow-md: 0 4px 24px rgba(0, 0, 0, 0.4);
  --finn-shadow-lg: 0 20px 50px rgba(0, 0, 0, 0.6);
  --finn-shadow-glow: 0 0 20px var(--finn-accent-glow);

  /* Radii */
  --finn-radius-sm: 6px;
  --finn-radius-md: 10px;
  --finn-radius-lg: 14px;
  --finn-radius-xl: 18px;
  --finn-radius-full: 9999px;

  /* Spacing scale (optional, for consistency) */
  --finn-space-1: 0.25rem;
  --finn-space-2: 0.5rem;
  --finn-space-3: 0.75rem;
  --finn-space-4: 1rem;
  --finn-space-6: 1.5rem;

  /* Typography */
  --finn-font-sans: 'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif;
  --finn-font-mono: ui-monospace, 'SF Mono', Menlo, Monaco, monospace;
  --finn-text-xs: 0.75rem;
  --finn-text-sm: 0.85rem;
  --finn-text-base: 0.95rem;
  --finn-text-lg: 1.1rem;

  /* Transitions */
  --finn-transition-fast: 150ms ease;
  --finn-transition-base: 200ms ease;
}

html, body {
  margin: 0;
  height: 100%;
  font-family: var(--finn-font-sans);
  background: var(--finn-bg-base);
  color: var(--finn-text-primary);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

a {
  color: var(--finn-accent);
  text-decoration: none;
  transition: color var(--finn-transition-fast);
}

a:hover {
  color: var(--finn-accent-hover);
}

/* Focus rings */
*:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--finn-border-focus);
}
```

**Step 3: Verify**

Run `npm run check` to ensure no TypeScript/Svelte errors were introduced.

---

## Task 2: Update Channel View (`+page.svelte`) — Layout & Chrome

**Objective:** Refresh the sidebar, header, composer, and main chrome of the channel view.

**Files:**
- Modify: `src/routes/+page.svelte` (style block only)

**Key changes in the `<style>` block:**

1. `.app` / root layout:
   - background → `var(--finn-bg-base)`
   - sidebar width slightly wider (260px → 280px) for breathing room

2. `.sidebar`:
   - background → `var(--finn-bg-elevated)`
   - border-right → `1px solid var(--finn-border)` (replace current `#2a2a30`)
   - padding → `var(--finn-space-4)`

3. `.sidebar h2`:
   - color → `var(--finn-text-muted)`
   - font-size → `var(--finn-text-xs)`
   - text-transform → `uppercase`
   - letter-spacing → `0.08em`
   - font-weight → `600`

4. `.add-btn`:
   - background → `var(--finn-bg-surface)`
   - border → `1px solid var(--finn-border)`
   - color → `var(--finn-text-secondary)`
   - border-radius → `var(--finn-radius-sm)`
   - hover: background → `var(--finn-bg-hover)`, border-color → `var(--finn-border-hover)`

5. `.channel-row`:
   - padding → `0.5rem 0.75rem`
   - border-radius → `var(--finn-radius-sm)`
   - color → `var(--finn-text-secondary)`
   - hover background → `var(--finn-bg-hover)`
   - active background → `var(--finn-accent-soft)`
   - active color → `var(--finn-accent-hover)`
   - font-weight → `500`

6. `.main header`:
   - background → `var(--finn-bg-elevated)`
   - border-bottom → `1px solid var(--finn-border)`
   - padding → `0.75rem var(--finn-space-4)`

7. `.channel-name`:
   - font-size → `var(--finn-text-lg)`
   - font-weight → `600`
   - color → `var(--finn-text-primary)`

8. `.channel-desc`:
   - color → `var(--finn-text-muted)`

9. `.search`:
   - background → `var(--finn-bg-input)`
   - border → `1px solid var(--finn-border)`
   - border-radius → `var(--finn-radius-sm)`
   - color → `var(--finn-text-primary)`
   - focus border-color → `var(--finn-accent)`

10. `.export-btn`, `.settings-link`:
    - background → `var(--finn-bg-surface)`
    - border → `1px solid var(--finn-border)`
    - border-radius → `var(--finn-radius-sm)`
    - hover → `var(--finn-bg-hover)` + `border-color: var(--finn-border-hover)`

11. `main` (message scroll area):
    - padding → `var(--finn-space-4)`
    - gap → `var(--finn-space-3)`

12. `.load-older`:
    - border-radius → `var(--finn-radius-full)`
    - border → `1px solid var(--finn-border)`
    - color → `var(--finn-text-muted)`
    - hover → `var(--finn-bg-hover)` + `var(--finn-text-secondary)`

13. `footer` (composer bar):
    - background → `var(--finn-bg-elevated)`
    - border-top → `1px solid var(--finn-border)`
    - padding → `var(--finn-space-3) var(--finn-space-4)`

14. `textarea` (composer):
    - background → `var(--finn-bg-input)`
    - border → `1px solid var(--finn-border)`
    - border-radius → `var(--finn-radius-md)`
    - color → `var(--finn-text-primary)`
    - focus border-color → `var(--finn-accent)`
    - add `transition: border-color var(--finn-transition-fast)`

15. `footer button` (send):
    - background → `var(--finn-accent)`
    - border → `none`
    - color → `#fff`
    - border-radius → `var(--finn-radius-sm)`
    - font-weight → `500`
    - hover → `var(--finn-accent-hover)` + `box-shadow: var(--finn-shadow-glow)`

16. `.menu` (channel/agent dropdown):
    - background → `var(--finn-bg-surface)`
    - border → `1px solid var(--finn-border)`
    - border-radius → `var(--finn-radius-md)`
    - box-shadow → `var(--finn-shadow-md)`

17. `.error` banner:
    - background → `var(--finn-error-bg)`
    - color → `var(--finn-error)`
    - border-radius → `var(--finn-radius-sm)`

18. `.member-row`, `.agent-id`, `.filter-row`:
    - Update all text colors to `--finn-text-secondary` / `--finn-text-muted`
    - `.dot.enabled` → `var(--finn-success)`
    - `.dot.disabled` → `var(--finn-text-disabled)`

---

## Task 3: Update MessageBubble

**Objective:** Make message bubbles feel like modern chat cards with subtle depth and cleaner metadata.

**Files:**
- Modify: `src/lib/ui/MessageBubble.svelte` (style block only)

**Key changes:**

1. `.row.user`, `.row.agent`, `.row.system`:
   - Add slight padding or gap adjustments

2. `.bubble`:
   - border-radius → `var(--finn-radius-md)` for agent/user
   - system bubbles: keep compact, muted

3. `.bubble.agent`:
   - background → `var(--finn-bg-surface)`
   - border → `1px solid var(--finn-border)` (optional — can be borderless for sleeker look)
   - padding → `0.75rem 1rem`

4. `.bubble.user`:
   - background → `var(--finn-accent-soft)`
   - border → `1px solid var(--finn-accent-glow)`
   - color → `var(--finn-text-primary)`

5. `.bubble.system`:
   - background → `transparent`
   - color → `var(--finn-text-muted)`
   - font-size → `var(--finn-text-sm)`
   - text-align → `center`

6. `.header`:
   - margin-bottom → `0.4rem`

7. `.who`:
   - font-weight → `600`
   - font-size → `var(--finn-text-sm)`
   - color → `var(--finn-text-primary)` for user, `var(--finn-text-secondary)` for agent

8. `.ts`:
   - color → `var(--finn-text-muted)`
   - font-size → `var(--finn-text-xs)`

9. `.badge` (approval status):
   - border-radius → `var(--finn-radius-full)`
   - padding → `0.15rem 0.5rem`
   - font-size → `var(--finn-text-xs)`
   - font-weight → `500`
   - `.pending` → background `rgba(251, 191, 36, 0.12)`, color `var(--finn-warning)`
   - `.approved` → background `rgba(52, 211, 153, 0.12)`, color `var(--finn-success)`
   - `.rejected` → background `var(--finn-error-bg)`, color `var(--finn-error)`
   - `.routed` → background `var(--finn-accent-soft)`, color `var(--finn-accent)`

10. `.stream-icon`:
    - `.stream-streaming` → color `var(--finn-accent)` with subtle pulse animation
    - `.stream-done` → color `var(--finn-success)`
    - `.stream-errored` → color `var(--finn-error)`

11. `.body`:
    - line-height → `1.6`
    - color → `var(--finn-text-primary)`

12. `.footer`:
    - margin-top → `0.5rem`
    - color → `var(--finn-text-muted)`
    - font-size → `var(--finn-text-xs)`
    - border-top → `1px solid var(--finn-border)` (optional)

13. `.toolbar`:
    - opacity → `0` by default, `1` on bubble hover
    - transition → `opacity var(--finn-transition-fast)`
    - `.toolbar-btn`:
      - background → `var(--finn-bg-hover)`
      - border → `1px solid var(--finn-border)`
      - border-radius → `var(--finn-radius-sm)`
      - color → `var(--finn-text-secondary)`
      - hover → `var(--finn-text-primary)` + `border-color: var(--finn-border-hover)`

14. `.approval-row` buttons:
    - Approve → `background: var(--finn-success); color: #000; border: none;`
    - Reject → `background: transparent; border: 1px solid var(--finn-error); color: var(--finn-error);`
    - border-radius → `var(--finn-radius-sm)`

15. `.error-line`:
    - color → `var(--finn-error)`
    - background → `var(--finn-error-bg)`
    - border-radius → `var(--finn-radius-sm)`
    - padding → `0.4rem 0.6rem`

16. `.disclosure-panel`:
    - background → `var(--finn-bg-hover)`
    - border-radius → `var(--finn-radius-sm)`
    - border → `1px solid var(--finn-border)`

17. `.session-badge`:
    - color → `var(--finn-accent)`
    - font-size → `var(--finn-text-xs)`
    - background → `var(--finn-accent-soft)`
    - border-radius → `var(--finn-radius-full)`
    - padding → `0.1rem 0.4rem`

18. `.forward-picker`:
    - background → `var(--finn-bg-surface)`
    - border → `1px solid var(--finn-border)`
    - border-radius → `var(--finn-radius-md)`
    - box-shadow → `var(--finn-shadow-md)`

---

## Task 4: Update Modal Component

**Objective:** Sleeker modal with glassmorphism feel.

**Files:**
- Modify: `src/lib/ui/Modal.svelte` (style block only)

**Key changes:**

1. `.backdrop`:
   - background → `rgba(0, 0, 0, 0.65)`
   - backdrop-filter → `blur(4px)` (subtle)

2. `.panel`:
   - background → `var(--finn-bg-surface)`
   - border → `1px solid var(--finn-border)`
   - border-radius → `var(--finn-radius-lg)`
   - box-shadow → `var(--finn-shadow-lg)`

3. `header`:
   - border-bottom → `1px solid var(--finn-border)`
   - padding → `0.75rem 1rem`

4. `header h2`:
   - font-size → `var(--finn-text-base)`
   - font-weight → `600`
   - color → `var(--finn-text-primary)`

5. `.close`:
   - color → `var(--finn-text-muted)`
   - hover → `var(--finn-text-primary)`
   - border-radius → `var(--finn-radius-sm)`
   - padding → `0.25rem 0.5rem`

6. `.body`:
   - padding → `var(--finn-space-4)`

---

## Task 5: Update Forms (ChannelForm + AgentForm)

**Objective:** Consistent, sleek form styling across all modals.

**Files:**
- Modify: `src/lib/ui/ChannelForm.svelte` (style block)
- Modify: `src/lib/ui/AgentForm.svelte` (style block)

**Key changes (apply to both):**

1. `input`, `textarea`, `select`:
   - background → `var(--finn-bg-input)`
   - border → `1px solid var(--finn-border)`
   - border-radius → `var(--finn-radius-sm)`
   - color → `var(--finn-text-primary)`
   - padding → `0.5rem 0.75rem`
   - font-size → `var(--finn-text-base)`
   - transition → `border-color var(--finn-transition-fast), box-shadow var(--finn-transition-fast)`
   - focus → `border-color: var(--finn-accent); box-shadow: 0 0 0 3px var(--finn-accent-glow);`

2. `.lbl`, `legend`:
   - color → `var(--finn-text-muted)`
   - font-size → `var(--finn-text-xs)`
   - font-weight → `500`
   - text-transform → `uppercase`
   - letter-spacing → `0.06em`

3. `fieldset`:
   - border → `1px solid var(--finn-border)`
   - border-radius → `var(--finn-radius-md)`
   - background → `var(--finn-bg-elevated)`

4. `.error`:
   - background → `var(--finn-error-bg)`
   - color → `var(--finn-error)`
   - border-radius → `var(--finn-radius-sm)`
   - font-size → `var(--finn-text-sm)`

5. `button` (Cancel):
   - background → `transparent`
   - border → `1px solid var(--finn-border)`
   - color → `var(--finn-text-secondary)`
   - border-radius → `var(--finn-radius-sm)`
   - hover → `background: var(--finn-bg-hover); border-color: var(--finn-border-hover);`

6. `button.primary`:
   - background → `var(--finn-accent)`
   - border → `none`
   - color → `#fff`
   - font-weight → `500`
   - border-radius → `var(--finn-radius-sm)`
   - hover → `background: var(--finn-accent-hover); box-shadow: var(--finn-shadow-glow);`

---

## Task 6: Update MentionPopup

**Objective:** Match the new autocomplete style.

**Files:**
- Modify: `src/lib/ui/MentionPopup.svelte` (style block)

**Key changes:**

1. `.popup`:
   - background → `var(--finn-bg-surface)`
   - border → `1px solid var(--finn-border)`
   - border-radius → `var(--finn-radius-md)`
   - box-shadow → `var(--finn-shadow-md)`

2. `.item`:
   - padding → `0.5rem 0.75rem`
   - color → `var(--finn-text-secondary)`
   - hover → `background: var(--finn-bg-hover);`
   - active/selected → `background: var(--finn-accent-soft); color: var(--finn-accent-hover);`

---

## Task 7: Update Protocol Viewer (`/protocol`)

**Objective:** Apply the same visual language to the audit surface.

**Files:**
- Modify: `src/routes/protocol/+page.svelte` (style block)

**Key changes:**

1. `.protocol-page` or root container:
   - background → `var(--finn-bg-base)`
   - color → `var(--finn-text-primary)`

2. `.filters` sidebar/panel:
   - background → `var(--finn-bg-elevated)`
   - border → `1px solid var(--finn-border)`
   - border-radius → `var(--finn-radius-md)`

3. Inputs, selects, checkboxes:
   - Same treatment as Task 5 (input styles)

4. `.hit-row` / message rows:
   - border-bottom → `1px solid var(--finn-border)`
   - padding → `0.75rem var(--finn-space-4)`
   - hover → `background: var(--finn-bg-hover)`

5. `.hit-meta`:
   - color → `var(--finn-text-muted)`
   - font-size → `var(--finn-text-xs)`

6. Buttons (Apply, Clear, Export, Load more):
   - Same button hierarchy as Task 5
   - Primary → `var(--finn-accent)`
   - Secondary → transparent with border

7. `.rendered-body` / markdown output:
   - color → `var(--finn-text-primary)`
   - code blocks → `background: var(--finn-bg-elevated); border-radius: var(--finn-radius-sm);`

---

## Task 8: Update Settings Page (`/settings`)

**Objective:** Match settings to the new chrome.

**Files:**
- Modify: `src/routes/settings/+page.svelte` (style block)

**Key changes:**

1. `.settings-page`:
   - background → `var(--finn-bg-base)`

2. `.rail`:
   - background → `var(--finn-bg-elevated)`
   - border-right → `1px solid var(--finn-border)`

3. `.rail button`:
   - color → `var(--finn-text-secondary)`
   - border-radius → `var(--finn-radius-sm)`
   - hover → `background: var(--finn-bg-hover);`
   - active → `background: var(--finn-accent-soft); color: var(--finn-accent-hover);`

4. `.rail h2`:
   - color → `var(--finn-text-muted)`
   - font-size → `var(--finn-text-xs)`
   - text-transform → `uppercase`
   - letter-spacing → `0.08em`

5. `.pane`:
   - padding → `var(--finn-space-6)`

6. `.field`:
   - gap → `0.5rem`

7. `.field label`:
   - color → `var(--finn-text-secondary)`
   - font-size → `var(--finn-text-sm)`
   - font-weight → `500`

8. `.field input`, `.field select`, `.field textarea`:
   - Same input treatment as Task 5

9. `.error`:
   - Same error treatment

10. Save / Discard buttons:
    - Same hierarchy as Task 5

---

## Task 9: Theme Persistence & Hookup

**Objective:** Wire the existing `theme` setting to actually affect the UI.

**Files:**
- Modify: `src/routes/settings/+page.svelte` (script block — `applyThemeToHtml`)
- Verify: `src/routes/+page.svelte` reads `document.documentElement.dataset.theme`

**Step 1: Update `applyThemeToHtml`**

```ts
function applyThemeToHtml(theme: Theme) {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = theme;
    // If system, resolve from media query
    if (theme === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.dataset.theme = prefersDark ? 'dark' : 'light';
    }
  }
}
```

**Step 2: Add listener for system theme changes**

```ts
let mediaQuery: MediaQueryList | null = null;
function listenSystemTheme() {
  if (typeof window === 'undefined') return;
  mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  mediaQuery.addEventListener('change', () => {
    if (global?.theme === 'system') applyThemeToHtml('system');
  });
}
```

Call `listenSystemTheme()` in `onMount`.

**Step 3: Ensure light mode vars exist**

For now, since the user wants a sleek *dark* UI, light mode can remain minimal or share the dark palette. The goal is warp.dev-style dark. If light mode is out of scope, note it in the plan.

---

## Task 10: Add Subtle Animations & Polish

**Objective:** Micro-interactions that make the UI feel alive.

**Files:**
- Modify: `src/app.css` (add keyframes)
- Modify: `src/routes/+page.svelte` (selectors)
- Modify: `src/lib/ui/MessageBubble.svelte` (selectors)

**Step 1: Add keyframes to `app.css`**

```css
@keyframes finn-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

@keyframes finn-fade-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
```

**Step 2: Streaming cursor pulse**

In MessageBubble:
```css
.cursor {
  animation: finn-pulse 1.2s ease-in-out infinite;
  color: var(--finn-accent);
}
```

**Step 3: Message entrance**

In `+page.svelte`, add a subtle fade to new messages:
```css
main > :global(*) {
  animation: finn-fade-in 200ms ease-out;
}
```
(Or scope to bubble rows if `:global` is too broad.)

**Step 4: Button hover transitions**

Ensure all buttons have:
```css
transition: background var(--finn-transition-fast), border-color var(--finn-transition-fast), box-shadow var(--finn-transition-fast), color var(--finn-transition-fast);
```

**Step 5: Composer glow on focus**

```css
textarea:focus {
  box-shadow: 0 0 0 3px var(--finn-accent-glow);
}
```

---

## Task 11: Markdown Output Styling

**Objective:** Ensure rendered markdown matches the new palette.

**Files:**
- Modify: `src/lib/ui/markdown.ts` OR create `src/lib/ui/markdown.css`

Since `renderMarkdown` returns HTML that is injected via `{@html}`, the styles must come from a global CSS block or `:global()` selectors.

**Option A:** Add a `:global` block in `MessageBubble.svelte` that styles the rendered markdown children.

**Option B:** Add rules to `app.css` scoped under a class.

Recommended rules:

```css
/* In MessageBubble.svelte <style> or app.css */
.body-rich :global(code) {
  background: var(--finn-bg-elevated);
  color: var(--finn-accent-hover);
  padding: 0.15rem 0.35rem;
  border-radius: var(--finn-radius-sm);
  font-family: var(--finn-font-mono);
  font-size: 0.9em;
}

.body-rich :global(pre) {
  background: var(--finn-bg-elevated);
  border: 1px solid var(--finn-border);
  border-radius: var(--finn-radius-md);
  padding: 0.75rem 1rem;
  overflow-x: auto;
}

.body-rich :global(pre code) {
  background: transparent;
  padding: 0;
  color: var(--finn-text-primary);
}

.body-rich :global(a) {
  color: var(--finn-accent);
  text-decoration: none;
}

.body-rich :global(a:hover) {
  text-decoration: underline;
}

.body-rich :global(blockquote) {
  border-left: 3px solid var(--finn-accent);
  margin: 0.5rem 0;
  padding-left: 0.75rem;
  color: var(--finn-text-secondary);
}

.body-rich :global(ul), .body-rich :global(ol) {
  padding-left: 1.25rem;
}

.body-rich :global(hr) {
  border: 0;
  border-top: 1px solid var(--finn-border);
  margin: 1rem 0;
}

.body-rich :global(table) {
  border-collapse: collapse;
  width: 100%;
}

.body-rich :global(th), .body-rich :global(td) {
  border: 1px solid var(--finn-border);
  padding: 0.4rem 0.6rem;
  text-align: left;
}

.body-rich :global(th) {
  background: var(--finn-bg-elevated);
  font-weight: 600;
  font-size: var(--finn-text-sm);
}
```

---

## Task 12: AgentChipInput Polish

**Objective:** Sleek chip input that matches the new style.

**Files:**
- Modify: `src/lib/ui/AgentChipInput.svelte` (style block)

**Key changes:**

1. `.chip-input` container:
   - background → `var(--finn-bg-input)`
   - border → `1px solid var(--finn-border)`
   - border-radius → `var(--finn-radius-md)`
   - focus-within → `border-color: var(--finn-accent); box-shadow: 0 0 0 3px var(--finn-accent-glow);`

2. `.chip`:
   - background → `var(--finn-accent-soft)`
   - color → `var(--finn-accent-hover)`
   - border-radius → `var(--finn-radius-full)`
   - font-size → `var(--finn-text-sm)`
   - font-weight → `500`

3. `.chip .remove`:
   - color → `var(--finn-accent)`
   - hover → `var(--finn-text-primary)`

4. `.chip-input input`:
   - background → `transparent`
   - color → `var(--finn-text-primary)`

---

## Task 13: Verify & Test

**Objective:** Ensure nothing is broken and the new styles look coherent.

**Commands:**
1. `npm run check` — TypeScript + Svelte validation
2. `npm run test` — Unit tests
3. `npm run dev` — Start dev server and visually inspect:
   - Channel view (sidebar, bubbles, composer)
   - Modals (create channel, create agent)
   - Mention autocomplete
   - Protocol viewer
   - Settings page
   - Responsive layout (narrow window)

**Checklist:**
- [ ] No hardcoded hex values remain in major components (use search `#` in `.svelte` files)
- [ ] All interactive elements have visible focus states
- [ ] Hover effects are consistent
- [ ] Text remains readable at all hierarchy levels
- [ ] The composer textarea expands correctly
- [ ] Streaming cursor animates
- [ ] Modal opens/closes smoothly
- [ ] Settings theme switcher still works

---

## Risks & Tradeoffs

1. **Light mode out of scope:** The current `theme` setting supports `light` and `system`. This plan focuses entirely on dark-mode polish. Light mode will inherit dark variables if `data-theme="light"` has no overrides. A future task can add `:root[data-theme="light"]` overrides.

2. **No design system framework:** We stay with hand-written CSS to match the existing architecture. A future migration to Tailwind or UnoCSS is possible but out of scope.

3. **Google Fonts dependency:** Inter is loaded from Google. If offline usage matters, we can self-host later.

4. **Accessibility:** The new contrast ratios must be checked. Violet on very dark gray (`#8b5cf6` on `#18181b`) has ~4.5:1 ratio, which passes WCAG AA for normal text. `#a1a1aa` on `#09090b` has ~6.5:1, which passes.

5. **Scope creep:** Resist the urge to redesign layout structure (e.g., move sidebar to bottom on mobile). This plan is color, type, radius, and shadow only.

---

## Open Questions

1. Should the accent color be configurable per-user in settings, or is violet fixed?
2. Should we add a subtle background gradient/noise texture to the base (like Warp does)?
3. Should message bubbles have a left colored border to indicate sender (user = violet, agent = neutral)?
