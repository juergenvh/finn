# ADR-0026 — Settings surface architecture

**Date:** 2026-06-12  
**Status:** Accepted  
**Closes:** issue #18, #148, #154

## Context

Agent and channel management previously lived as modal forms opened
from sidebar buttons. As the number of agents grew and the sidebar
was removed (ADR-0025), a proper home for configuration was needed.

## Decision

A dedicated `/settings` route with a three-entry rail (Global /
Agents / Channels):

**Global** — KB budget default, roundtrip cap default, theme,
default channel, auto-approve default. Form fields auto-save on blur
(number inputs) or change (checkboxes/selects); no explicit Save
button.

**Agents** — Card list with expand/collapse per agent. Collapsed:
status dot + name + connector type + channel assignment chips.
Expanded (▼ chevron): inline edit fields for all connector-specific
config (base URL, token env var, model, session override). Save/
Cancel appear only when expanded. New agent: inline form above the
list. Export/import via JSON file. No modal.

**Channels** — Card list. Name/description editable inline (click
Edit, Enter/Escape). Agent assignment chips with × remove and
dropdown to add. Per-channel settings (KB budget, auto-approve,
roundtrip cap) inline in each card, auto-save on blur/change.
"Reset to global" small link. No modal.

## Consequences

- No modals in Settings (AgentForm.svelte no longer needed there).
- All editing is inline — what you see is what you edit.
- Settings page is self-contained; `/` has no CRUD surfaces.
- Per-channel settings previously accessed via sidebar sub-entries
  are now inline in the Channels card for each channel.
