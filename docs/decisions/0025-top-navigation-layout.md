# ADR-0025 — Top-navigation layout, sidebar removal

**Date:** 2026-06-12  
**Status:** Accepted  
**Closes:** issue #147, depends on #148/#154

## Context

The left sidebar occupied a fixed 280 px of horizontal space on every
channel view. As finn gained more daily use, the wasted real estate
became friction: the chat window felt narrow, and the sidebar was doing
three distinct jobs (channel switching, agent management, message
filtering) that pulled in opposite directions.

Issues #148 and #154 moved agent and channel management into a dedicated
`/settings` surface. That cleared the sidebar of its most complex
responsibility and made it safe to remove.

## Decision

Replace the sidebar with:

1. **Top navigation bar** — brand logo, channel dropdown (switch with
   one click, no separate page), search + export + filter pills
   (system/rejected/groomed), protocol viewer link, settings gear.

2. **Agent toggle bar** — slim bar below the nav, one chip per active
   channel member. Toggle = show/hide that agent's messages
   (`hiddenAgentIds`). No add/manage buttons — that is Settings.

3. **Chat section** takes the full remaining height. No grid columns.

## Consequences

- Chat window gains ~280 px horizontal space.
- Channel switching is one click from anywhere.
- Filter state (system/rejected/groomed) moves from checkboxes into
  pill buttons in the nav, always visible.
- Agent management is `/settings`, not an inline sidebar panel.
- `<aside>` element and all sidebar CSS removed (~280 lines).
