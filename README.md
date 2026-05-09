# finn

> *"Finn? Talks to the dead, mostly."*
> — *Neuromancer*, William Gibson

<img width="1024" height="559" alt="image" src="https://github.com/user-attachments/assets/3cb8b038-0edc-4e76-854f-132355bd7ff0" />

A multi-agent chat UI with human-in-the-loop approval. One window, many
agents (LLM endpoints, agent frameworks, anything that speaks HTTP),
and a human routing every cross-agent message by hand. Named after
Gibson's Finn — the fixer who routes between the living and the
ROM-stored dead.

**Status:** working spike, with day-to-day usable surface area.
Single- and two-machine setups verified end-to-end. The application
is structurally split into two surfaces:

- **Channel view** (`/`) — conversational. Per-channel chat with
  KB-budgeted initial load, mention autocomplete, approval flow for
  cross-agent traffic, in-browser CRUD for channels and agents, and
  user-controlled grooming.
- **Protocol viewer** (`/protocol`) — audit. Cross-channel browse,
  search, filter, and markdown export of the full message history
  including groomed rows.

Rich-rendering / Markdown for message bodies, settings surface,
and launchd integration are tracked as open issues; see §"Roadmap".
Token-streaming and per-message token-usage display landed in
ADR-0013 phases 2–3 and issue #43. Manual message forwarding
(↗ on a bubble routes it to picked agents directly, ADR-0014)
is live. Wintermute and any other OpenAI-compatible backend
are reachable via the `openai-compatible` connector type.

## What it is

A web UI for chatting with several agents from one place. Each
channel can hold one or more agents; the user is always present.
When two or more agents share a channel, every cross-agent message
goes through an explicit Approve / Reject step at the UI, so the
human is structurally always in the routing loop.

**It is not:**

* an agent itself (no LLM, no tools, no memory of its own beyond a
  transcript log)
* a generalised messaging platform (single-user, internal use only)
* tied to any particular agent stack (OpenClaw, Wintermute, raw LLM
  APIs are all just connectors)

## Why

Sitting at one keyboard and switching between five chat surfaces —
OpenClaw on the Mac host, OpenClaw remote, OpenClaw in a VM,
Wintermute on a server, raw API calls to Claude / Moonshot / etc. —
is the daily friction this tool removes. As a side effect, it lets
two or more agents "talk" via the user as relay, with the
conversation visible to all parties and logged centrally.

The structural payoff: the same human-in-the-loop pattern that
prevents inter-agent feedback loops from spiralling stays *built into*
the medium. There is no agent-to-agent direct channel; routing is the
user's job, mediated by the UI.

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│  Browser                                                           │
│   /                                                                │
│     src/routes/+page.svelte                  ← channel view        │
│     src/lib/ui/{MessageBubble, Modal,                              │
│                 ChannelForm, AgentForm,                            │
│                 MentionPopup}.svelte                               │
│   /protocol                                                        │
│     src/routes/protocol/+page.svelte         ← audit surface       │
└──────────────────┬─────────────────────────────────────────────────┘
                   │
                   │  HTTP REST                  WebSocket /ws
                   │   /api/channels, /api/agents  • chat events
                   │   /api/messages/:id/visibility • approval events
                   │   /api/protocol, .../export    • state_changed
                   ▼
┌────────────────────────────────────────────────────────────────────┐
│  finn server (SvelteKit + Node)                                    │
│                                                                    │
│   ┌────────────────────┐  ┌────────────────┐  ┌──────────────────┐ │
│   │  src/routes/api/   │  │  attach.ts     │  │  hooks (per turn)│ │
│   │  REST writes       │◀─│  WS broadcast  │◀─│  user_message    │ │
│   │  zod validation    │  │  globalThis    │  │  approval_decide │ │
│   └─────────┬──────────┘  └────────────────┘  └─────────┬────────┘ │
│             │                                           │          │
│             ▼                                           ▼          │
│   ┌──────────────────────────────────────────────────────────────┐ │
│   │  core engine                                                 │ │
│   │   • messages.ts        append-only writers + scope=all/chan  │ │
│   │   • approvals.ts       state machine                         │ │
│   │   • mentions.ts        @-parser, channel-scoped resolve      │ │
│   │   • channel-agent.ts   per-channel agent lookup              │ │
│   │   • protocol.ts        cross-channel filter + cursor pagin.  │ │
│   │   • export-channel.ts  per-channel + cross-channel markdown  │ │
│   │   • connectors/registry.ts                                   │ │
│   └─────────────────────────────┬────────────────────────────────┘ │
│                                 │                                  │
│   ┌─────────────────────────────┴────────────────────────────────┐ │
│   │  connectors                                                  │ │
│   │   • openclaw.ts          OpenClaw Gateway w/ scopes/sess-key │ │
│   │   • openai-compatible.ts vanilla OpenAI Chat Completions     │ │
│   │   • anthropic-stub.ts    canned replies, dev/test            │ │
│   │   • sse-parser.ts        shared SSE-frame consumer (PR #39)  │ │
│   │   • (planned) anthropic.ts — direct, bypassing OpenClaw     │ │
│   └─────────────────────────────┬────────────────────────────────┘ │
│                                 │                                  │
│   ┌─────────────────────────────┴────────────────────────────────┐ │
│   │  persistence                                                 │ │
│   │   • db/{schema, client, ids, agent-config}.ts                │ │
│   │   • SQLite via Drizzle ORM   →  ~/finn-data/finn.db          │ │
│   └──────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌────────────────────────────────────────────────────────────────────┐
│  agent endpoints (out-of-process, HTTP)                            │
│   • OpenClaw Gateway        scoped operator headers (ADR-0001)     │
│   • Wintermute /v1/*        OpenAI-compat, bearer-gated, TLS       │
│   • Other OpenAI-compat    Open WebUI, vLLM, llama.cpp, …          │
│   • Anthropic API direct   planned                                 │
└────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│  ~/finn-data/                                                      │
│    finn.db                 SQLite database (managed by Drizzle)    │
│    secrets/.env            bearer tokens; chmod 600                │
│    exports/                markdown channel exports (planned)      │
└────────────────────────────────────────────────────────────────────┘
```

### Stack

* **Frontend + backend in one repo:** SvelteKit (single deployable, BFF
  pattern matches the use case).
* **Persistence:** SQLite via Drizzle ORM. File-based, no extra service.
  Migrate to Postgres later if the log volume warrants it.
* **Real-time:** WebSocket between browser and server, with streaming
  hooks — broadcasts go out as soon as each piece is ready, so the
  user's own bubble appears immediately and connector latency does
  not delay it.
* **Validation:** Zod for connector configs (discriminated union per
  `connector_type`).

### Why these choices

* **SvelteKit over a Python stack:** finn is a frontend-shaped
  problem; Python's strengths are wasted here, JavaScript's
  WebSocket and DOM stories are not.
* **SQLite over Postgres / Qdrant:** the log is append-only structured
  data, no semantic search, no high concurrency. SQLite is the right
  size.
* **WebSocket only between browser and server:** connectors target
  agents that may speak only HTTP. Lifting the WebSocket requirement
  to the server boundary keeps every connector independently
  implementable.
* **Application-layer message immutability** (ADR-0004): no DELETE
  path in code; the chat log is the audit log.
* **Application-generated IDs** (ADR-0003): prefixed nanoid-12 ids
  read well in URLs, headers, and human conversation.

## Data model

Five tables. The first four are the core; the fifth (`approvals`) is
what makes the human-in-the-loop pattern explicit in the schema.

```sql
agents          -- configured endpoints
  id, name, connector_type, config (json), enabled,
  created_at, deleted_at        -- soft-delete (ADR-0004)

channels        -- rooms with 1..N agents
  id, name, description,
  created_at, deleted_at        -- soft-delete (ADR-0004)

channel_members -- which agents are in which channel
  channel_id, agent_id, joined_at  -- hard-delete (ADR-0004)

messages        -- everything that's been written
  id, channel_id, sender_type (user|agent|system), sender_id,
  body, created_at, parent_message_id,
  hidden_at, hidden_by          -- visibility marker (ADR-0004 addendum)
                                -- content immutable; visibility mutable

approvals       -- the human-in-the-loop step (ADR-0005)
  id, message_id,
  status (pending|approved|rejected|routed),
  targeted_agent_ids (JSON array),
  reject_reason (nullable),
  created_at, decided_at        -- append-only (ADR-0004)
```

A separate `audit_log` table is *not* needed: `messages` joined with
`approvals` already records every byte sent, every routing decision,
every reject reason, with timestamps. Markdown export is a SELECT.

See [`docs/decisions/0003-id-formats.md`](docs/decisions/0003-id-formats.md)
for the ID format and
[`docs/decisions/0004-message-persistence.md`](docs/decisions/0004-message-persistence.md)
for the per-table delete policies.

## Approval flow

State machine (ADR-0005):

```
pending ──approve──▶ approved ──relay done──▶ routed
   │
   └──reject──▶ rejected
```

Triggers:

* **User → agent**: no approval (the user is the human-in-the-loop;
  their message is already decided).
* **Agent → user** (no `@-mention` to other agents): no approval.
* **Agent → agent** (any `@-mention` of another channel member):
  one approval row per such message, status `pending`.
* **User-triggered forward** (user clicks ↗ on an existing
  bubble): the picked targets receive the body verbatim. The
  user's deliberate click *is* the human-in-the-loop step; the
  approval row lands directly in `routed` status. ADR-0014 has
  the full rationale (forwarding is a second legitimate routing
  shape, not a bypass of the gate).

Each agent message bubble carries its approval state inline: status
badge, target picker (pre-filled from `@-mentions`, user-overridable),
Approve / Reject buttons, optional reject reason. There is no
separate approval inbox — the message is the unit of decision.

Full rationale, sender experience, recursive approval semantics, and
wire protocol: [`docs/decisions/0005-approval-flow.md`](docs/decisions/0005-approval-flow.md);
forwarding details in [`docs/decisions/0014-user-triggered-forwarding.md`](docs/decisions/0014-user-triggered-forwarding.md).

## Addressing model

* **1:1 channel** (user + one agent): the user's message goes to the
  agent. The agent replies. No approvals.
* **Multi-agent channel** (user + N agents): the user's message
  fans out to *all* agents in parallel (no approval). Each agent's
  reply that mentions another channel member produces a `pending`
  approval; the user can approve, modify the target set, or reject.

Mentions are convenience for pre-filling the target picker. The
user's choice in the approval UI is what actually routes.

## Wire protocol

### WebSocket (`/ws`)

Inbound (client → server):

```ts
{ type: 'user_message',     channel_id, body }
{ type: 'approval_decide',  approval_id, decision: 'approve'|'reject',
                             targets?, reject_reason? }
{ type: 'forward_message',  message_id, target_agent_ids: string[] }
{ type: 'ping' }
```

Outbound (server → client, streamed via per-event broadcast):

```ts
// User and system messages — single event, body arrives whole.
{ type: 'message',          channel_id, sender, sender_id, body, ts, id }

// Agent replies — four-event streaming lifecycle (ADR-0013).
{ type: 'message_start',    id, channel_id, sender_id, ts }
{ type: 'message_delta',    id, delta }
{ type: 'message_end',      id, body, tokens? }      // tokens optional, issue #43
{ type: 'message_error',    id, error }              // mutually exclusive with message_end

// Approval lifecycle.
{ type: 'approval_created', approval, message_id }   // for mention-approvals AND forwards
{ type: 'approval_updated', approval }

// Domain CRUD echo.
{ type: 'state_changed',    entity: 'channel'|'agent'|'channel_member'|'message',
                             action: 'created'|'updated'|'deleted',
                             id, extra? }

// Misc.
{ type: 'system',           body }
{ type: 'pong' }
```

`state_changed` events with `entity: 'message'` carry the
channel id and the new `hidden` boolean in `extra`, so connected
clients can update visibility without a full refetch. The
protocol viewer at `/protocol` does not subscribe to live events
— it is a snapshot surface (ADR-0010 §5).

User-message `message` events arrive as soon as each one is
persisted, so the user's own bubble appears in milliseconds.
Agent replies stream as `message_start` → N × `message_delta`
→ `message_end` (or `message_error`) so the channel sees per-
recipient bubbles fill at their own pace, and the slowest agent
never blocks the rest. `state_changed` notifies connected
clients of CRUD changes (a channel renamed in one tab is reflected
in another within a roundtrip). See `src/lib/server/ws/attach.ts`
for the canonical schema.

### REST API (`/api`)

Read:

```
GET    /api/channels                              list active channels
GET    /api/channels/:id/messages                 message history
                                                  (?limit=&before= | ?budget=<kb>)
GET    /api/channels/:id/search?q=                substring search in channel
GET    /api/channels/:id/export?format=md         single-channel markdown download
GET    /api/channels/:id/members                  channel members
GET    /api/channels/:id/approvals                approval state hydration
GET    /api/agents                                list active agents
                                                  (?include_archived=1)
GET    /api/agents/:id                            single (with parsed config)
GET    /api/protocol                              cross-channel audit query
                                                  (filters: channels=&q=&sender_types=&
                                                   senders=&from=&to=&visibility=&
                                                   only_rejected=&cursor=&limit=)
GET    /api/protocol/export?format=md             cross-channel markdown download
                                                  (same filter params)
```

The channel `messages` endpoint has two modes: `limit`+`before` for
'load older' pagination, or `budget=<kb>` for the KB-bounded initial
load (ADR-0011). The protocol endpoints share the same filter
vocabulary; pagination there is cursor-based on `(created_at, id)`
(ADR-0010). Both export endpoints set `Content-Disposition:
attachment` so the browser saves the file.

Write (all bodies validated by zod; all writes also broadcast a
`state_changed` WS event):

```
POST   /api/channels                              create
PATCH  /api/channels/:id                          rename / re-describe
DELETE /api/channels/:id                          soft-delete (Archive)
POST   /api/channels/:id/members                  add member
DELETE /api/channels/:id/members/:agentId         remove member
POST   /api/agents                                create
PATCH  /api/agents/:id                            name / enabled / config
DELETE /api/agents/:id                            soft-delete (Archive)
PATCH  /api/messages/:id/visibility               groom: hide / unhide
```

`connector_type` is locked at agent creation; PATCH ignores any
attempt to change it (ADR-0007 §"Decision 3").

Message visibility is the one allowed mutation on the messages
table. Body, sender, and timestamp remain immutable; only
`hidden_at` and `hidden_by` flip on grooming. See ADR-0004's
2026-05-07 addendum for the 'immutable but extendable' discipline.

## Capabilities (working today)

In ascending order of integration weight:

1. **One-on-one chat** ✓ — user ↔ agent over OpenClaw connector,
   per-channel session continuity (ADR-0002 + 0012).
2. **OpenAI-compatible connector** ✓ — talks to any backend that
   speaks vanilla OpenAI Chat Completions. Verified end-to-end
   against Wintermute's `/v1/*` adapter at `agent.storm7.de`.
   See `docs/connectors.md` Scenario C.
3. **Anthropic connector** — *stub only* today (canned replies for
   exercising the multi-agent flow without a real key). Anthropic
   Cloud is otherwise reachable via the `openclaw` connector when
   OpenClaw is configured for it; a direct connector that bypasses
   OpenClaw is on the roadmap.
4. **Multi-agent channel** ✓ — user, OpenClaw, OpenAI-compat
   (Wintermute), and/or stub agents in one room. `@-mentions`,
   targeted approval, recursive approval for relayed replies that
   mention yet another agent.
5. **Channel + agent CRUD UI** ✓ — in-browser create / edit /
   disable / archive via modal forms. Live cross-tab sync via
   `state_changed` WS events. ADR-0007.
6. **Log surface** ✓ — backwards pagination ('Load older'),
   per-channel substring search, sender / system / rejected-
   approval filters in the sidebar, full-channel markdown export
   as browser download. ADR-0009.
7. **Mention autocomplete** ✓ — typing `@` in the composer pops
   up channel-member candidates, keyboard-navigable. ADR-0009 §5/6.
8. **User-mention dispatch filtering** ✓ — `@gwen hi` in a
   multi-agent channel only dispatches to Gwen, not to every
   channel member. Closed by PR #29 (issue #27).
9. **KB-budget initial load** ✓ — channel view caps cumulative
   body size on first paint (default 200 KB). 'Load older' still
   walks back further. ADR-0011.
10. **Channel grooming** ✓ — hide-from-channel-view marker on each
    message bubble; protocol viewer and exports ignore the marker
    per audit discipline. ADR-0004 addendum.
11. **Protocol viewer** ✓ — separate `/protocol` route. Cross-
    channel browse with multi-channel filter, full-text search,
    sender filter (type + specific agent), date range, visibility
    selector, only-rejected flag, cursor-paginated, markdown export
    of the current filter result. URL search-params are the filter
    source-of-truth. ADR-0010.
12. **End-to-end token streaming** ✓ — the dispatcher fans out
    via `streamUserMessage` / `streamToAgent`, both driving the
    per-agent `streamOneAgent` core that emits
    `message_start`/`delta`/`end` (or `error`) over the WebSocket.
    SSE parsing is in `sse-parser.ts`; per-message token usage
    is captured from the upstream `usage` block when the backend
    reports one and persisted as `messages.tokens_json`. ADR-0013
    + issue #43.
13. **User-triggered forwarding** ✓ — ↗ in a bubble's hover
    toolbar relays the body verbatim to picked channel members,
    landing directly in `routed` status; the user's deliberate
    click *is* the human-in-the-loop step. ADR-0014.
14. **Streaming status icon + token-count footer in bubbles** ✓
    — ● streaming, ✓ done, ⚠ errored in the header;
    `tokens: total (↓input, ↑output)` in the footer when the
    backend reports usage. Issue #43.

## What this is **not** doing

* **Authentication.** Single-user local tool. Adding auth is its own
  ADR (planned for when finn moves off the Mac+VM trust domain).
* **Agent-to-agent direct connectors.** Everything goes through the
  UI. By design.
* **Files, images, voice.** Future ADRs.
* **Cross-channel search beyond the protocol viewer.** Today's
  search lives at `/protocol`; an integrated cross-channel search
  in the conversational view is a follow-up under the same
  surface.

## Layout on disk

```
~/Repositories/finn/      # repo
~/finn-data/              # persistent state, never touched by the repo
  ├─ finn.db              # SQLite database
  ├─ finn.db-wal          # SQLite WAL, present at runtime
  ├─ finn.db-shm          # SQLite shared memory
  ├─ secrets/
  │   └─ .env             # bearer tokens (chmod 600)
  └─ exports/             # markdown exports for NotebookLM, etc. (planned)
```

The repo never writes to `~/finn-data/`. Database file stays out of
the repo. Secrets stay out of the repo. Exports stay out of the repo.

## Setup

Two full setup guides, depending on where the OpenClaw gateway runs:

- **[`docs/setup.md`](docs/setup.md)** — finn and gateway on the
  same host (single-machine). Loopback-only.
- **[`docs/setup-mac.md`](docs/setup-mac.md)** — finn on macOS,
  gateway in a UTM VM (two-machine). Adds a network path between
  the two; raises the urgency of the trust-mode migration documented
  in ADR-0001 §"Addendum 2026-05-07".

TL;DR for the single-machine variant:

```bash
npm install
mkdir -p ~/finn-data/secrets
echo 'FINN_OPENCLAW_API_KEY=<your-gateway-token>' > ~/finn-data/secrets/.env
chmod 600 ~/finn-data/secrets/.env
npm run db:migrate
npm run db:seed
npm run dev
```

For Mac+VM, the env file additionally needs `FINN_OPENCLAW_BASE_URL`
pointing at the VM gateway, and the VM must have its gateway bind
switched from `loopback` to `lan`. Full walkthrough in
[`docs/setup-mac.md`](docs/setup-mac.md).

## Trust model

finn is a **scoped operator UI**, not a sandboxed application. It is
for the same human who operates the connected agents, and it talks to
those agents over an authenticated channel.

The target authentication architecture:

- Each connected OpenClaw Gateway runs in `trusted-proxy` mode, with
  the network source (tailscale, loopback, or equivalent) as the
  trust boundary.
- finn always sends `x-openclaw-scopes: operator.read operator.write`
  on every request. Admin, approvals, pairing, and secrets-talking
  scopes are explicitly *not* requested.
- A finn process compromised at the application layer therefore
  cannot reconfigure a gateway, manipulate the approval queue, pair
  new devices, or reach the secrets-talking surface — it is bounded
  by what `operator.read` + `operator.write` allow.
- The bearer secret lives at `~/finn-data/secrets/.env` with `0600`
  permissions, outside the repository.

In the **current transitional posture**, gateways may still run in
`token` mode, in which case the scope header is ignored and finn
behaves as a full operator (same trust posture as the OpenClaw TUI on
the same host). The code is already written for the target posture;
the migration is a gateway-config task, not a finn change.

Full rationale, options considered, transitional posture, and
migration sketch:
[`docs/decisions/0001-openclaw-connector-auth.md`](docs/decisions/0001-openclaw-connector-auth.md).

## What's deliberately *not* here

* **storm7.** This project has nothing to do with the storm7.de stack.
  No subdomain, no shared infrastructure, no overlap.
* **MCP / tool-use.** finn is a chat router, not an agent. Agents may
  have their own tools (and many will), but finn neither knows nor
  cares.
* **Agent memory.** The transcript log is *the user's* logbook,
  read by humans, not by agents. Connectors do not query it.

## Roadmap

Issues are tagged with `phase 1` / `phase 2` / `phase 3` labels
reflecting how directly they affect daily-use viability. Phase 1
issues are what stand between the current spike and finn being a
tool you reach for every day.

**Phase 1 — daily-use blockers:**

* **#1** Discovery: rich-rendering for message bubbles
  (Markdown? something else?). The current bubble already plays
  in monospace; this is the layer above. Carries an attached
  scroll-discipline thread (auto-scroll vs late-arriving
  approvals / markdown finalisation) since 2026-05-09.

**Phase 2 — quality-of-life:**

* **#18** Settings surface — global defaults vs per-channel
  overrides for KB budget and other knobs.
* **#26** Channel-create member selection UX (email-client-style
  chips).
* **#28** Per-channel toggle to auto-approve agent-to-agent
  mentions.
* **#43** (open: footer-consistency follow-up) Token-usage
  display — Part A (streaming status icon ●/✓/⚠) and Part B
  (per-message token-count footer) both shipped (PRs #44, #50,
  #51); the issue stays as the meta-thread until the
  always-on-footer follow-up (commented in #1) lands.
* **#46** Discovery: Multi-User with SSO and separate creds.
  Strategic question, not a blocker.

**Phase 3 — nice-to-have / discovery:**

* **#6** Discovery: where session memory lives
  (finn ↔ agent ↔ user) — plus the addendum on memory-storage
  signalling from connectors.
* **#22** Discovery: connector backend-model override
  (`x-openclaw-model`).
* **#25** Bug: cannot reuse channel name after archive.
* **#30** Discovery: protocol-viewer audit-aware channel picker
  (archived channels missing from the filter).
* **#49** Discovery: finn artwork in sidebar brand area.

Follow-ups under earlier issues:

* SQLite FTS5 / ranked search when LIKE feels slow.
* Range-select mark-and-export of a channel slice.
* Date-jumper / calendar pagination for very long channels.
* Persisted per-user filter preferences (folds into #18).
* Server-side `~/finn-data/exports/` write alongside the
  browser download.

**Closed since the last roadmap refresh** (2026-05-08–2026-05-09):

* **#3** Token-streaming + reply-sequencing — ADR-0013 phases
  1–3 + post-phase-3 sweep all shipped (PRs #39, #41, #42,
  #45, #47).
* **#52** Manual message forwarding — ADR-0014 (PRs #53, #54).
* **#23**, **#27**, **#34**, **#36** — see prior daily logs.
* `#channel` autocomplete in the composer.
* `?channel=<id>` query-param handler at `/` so the protocol
  viewer's channel-pill links land on the right channel.
* Tab-switcher layout once a third audit-style surface
  appears (ADR-0010 §1 'when to revisit').

Other known work, not yet ticketed:

* Real Anthropic connector (replaces the stub).
* Approval-recovery on server restart while a row is `approved`.
* Tests (unit + integration; current debt).
* `launchd` plist for `npm run start` once the spike stabilises.
* OpenClaw gateway auth-mode migration to `trusted-proxy` for
  cross-machine deployments (see ADR-0001 addendum).

## Documentation

| File                                                                                       | Purpose                                                |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| `README.md` (this file)                                                                    | front door, capabilities, links                        |
| `docs/contributing.md`                                                                     | branch / PR workflow (ADR-0006)                        |
| `docs/setup.md`                                                                            | single-machine setup (gateway local)                   |
| `docs/setup-mac.md`                                                                        | two-machine setup (gateway in VM)                      |
| `docs/decisions/`                                                                          | ADRs — architectural decisions, immutable + numbered   |
| `docs/lessons.md`                                                                          | mistakes made, fixes shipped, things to remember       |
| `src/lib/server/README.md`                                                                 | the two-build convention for server modules            |

## Provenance

This README, the architecture sketch, and the implementation are a
collaboration between Jürgen (project owner) and Dixie (sister-agent
of the OpenClaw-on-VM instance), starting 2026-05-06. The
conversation that shaped the design happened in those daily
sessions; the design decisions are pinned in `docs/decisions/` so
they are not lost when sessions reset.

Commits are authored as Dixie with `Co-authored-by` for Jürgen so
GitHub provenance reflects both.

## Related projects

* `juergenvh/wintermute` — personal AI agent (Python, on Hetzner).
  Will get a finn-connector eventually but is not part of this stack.
* `juergenvh/openclaw-server` — storm7 deployment configs. Unrelated
  to finn; mentioned only so it's clear they don't share anything.
* `juergenvh/agenticframework` — the universal meta-framework. Also
  unrelated; finn is a tool, not a phase.
