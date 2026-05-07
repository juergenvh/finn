# finn

> *"Finn? Talks to the dead, mostly."*
> — *Neuromancer*, William Gibson

A multi-agent chat UI with human-in-the-loop approval. One window, many
agents (LLM endpoints, agent frameworks, anything that speaks HTTP),
and a human routing every cross-agent message by hand. Named after
Gibson's Finn — the fixer who routes between the living and the
ROM-stored dead.

**Status:** working spike, with day-to-day usable surface area.
Single- and two-machine setups verified end-to-end. Core
capabilities — persistent channels, streaming WS chat, OpenClaw
connector, approval flow for cross-agent traffic, in-browser CRUD
for channels and agents — are in place. Real Anthropic connector,
log/transcript surface, mention autocomplete, markdown rendering
and markdown export, token-streaming, and launchd integration are
tracked as open issues; see §"Roadmap".

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
┌─────────────────────────────────────────────────────────────────────┐
│  Browser                                                            │
│   src/routes/+page.svelte                                           │
│   src/lib/ui/{MessageBubble, Modal, ChannelForm, AgentForm}.svelte  │
└──────────────────┬──────────────────────────────────────────────────┘
                   │
                   │  HTTP REST                  WebSocket /ws
                   │   GET/POST/PATCH/DELETE      • chat events
                   │   /api/channels, /api/agents • approval events
                   │                              • state_changed events
                   ▼
┌────────────────────────────────────────────────────────────────────┐
│  finn server (SvelteKit + Node)                                    │
│                                                                    │
│   ┌───────────────────┐  ┌────────────────┐  ┌───────────────────┐ │
│   │  src/routes/api/  │  │  attach.ts     │  │  hooks (per turn) │ │
│   │  REST writes      │◀─│  WS broadcast  │◀─│  user_message     │ │
│   │  zod validation   │  │  globalThis    │  │  approval_decide  │ │
│   └─────────┬─────────┘  └────────────────┘  └─────────┬─────────┘ │
│             │                                          │           │
│             ▼                                          ▼           │
│   ┌──────────────────────────────────────────────────────────────┐ │
│   │  core engine                                                 │ │
│   │   • messages.ts        append-only writers                   │ │
│   │   • approvals.ts       state machine                         │ │
│   │   • mentions.ts        @-parser, channel-scoped resolve      │ │
│   │   • channel-agent.ts   per-channel agent lookup              │ │
│   │   • connectors/registry.ts                                   │ │
│   └─────────────────────────────┬────────────────────────────────┘ │
│                                 │                                  │
│   ┌─────────────────────────────┴────────────────────────────────┐ │
│   │  connectors                                                  │ │
│   │   • openclaw.ts          OpenAI-compatible HTTP API          │ │
│   │   • anthropic-stub.ts    canned replies, dev/test            │ │
│   │   • (planned) anthropic.ts, wintermute.ts                    │ │
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
│   • Anthropic API           planned                                │
│   • Wintermute, ...         planned                                │
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
  body, created_at, parent_message_id   -- append-only (ADR-0004)

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
  one approval row per such message.

Each agent message bubble carries its approval state inline: status
badge, target picker (pre-filled from `@-mentions`, user-overridable),
Approve / Reject buttons, optional reject reason. There is no
separate approval inbox — the message is the unit of decision.

Full rationale, sender experience, recursive approval semantics, and
wire protocol: [`docs/decisions/0005-approval-flow.md`](docs/decisions/0005-approval-flow.md).

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
{ type: 'user_message',    channel_id, body }
{ type: 'approval_decide', approval_id, decision: 'approve'|'reject',
                            targets?, reject_reason? }
{ type: 'ping' }
```

Outbound (server → client, streamed via per-event broadcast):

```ts
{ type: 'message',           channel_id, sender, sender_id, body, ts, id }
{ type: 'approval_created',  approval, message_id }
{ type: 'approval_updated',  approval }
{ type: 'state_changed',     entity: 'channel'|'agent'|'channel_member',
                              action: 'created'|'updated'|'deleted',
                              id, extra? }
{ type: 'system',            body }
{ type: 'pong' }
```

`message` events arrive as soon as each one is persisted, so the
user's own bubble appears in milliseconds; agent replies arrive
when their connector returns. `state_changed` notifies connected
clients of CRUD changes (a channel renamed in one tab is reflected
in another within a roundtrip). See `src/lib/server/ws/attach.ts`
for the canonical schema.

### REST API (`/api`)

Read:

```
GET    /api/channels                              list active channels
GET    /api/channels/:id/messages                 message history
GET    /api/channels/:id/members                  channel members
GET    /api/channels/:id/approvals                approval state hydration
GET    /api/agents                                list active agents
                                                  (?include_archived=1)
GET    /api/agents/:id                            single (with parsed config)
```

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
```

`connector_type` is locked at agent creation; PATCH ignores any
attempt to change it (ADR-0007 §"Decision 3").

## Capabilities (working today)

In ascending order of integration weight:

1. **One-on-one chat** ✓ — user ↔ agent over OpenClaw connector,
   per-channel session continuity (ADR-0002).
2. **Anthropic connector** — *stub only* today (canned replies for
   exercising the multi-agent flow without a real key). Real
   implementation is on the roadmap.
3. **Multi-agent channel** ✓ — user, OpenClaw, and stub-Anthropic
   in one room. `@-mentions`, targeted approval, recursive approval
   for relayed replies that mention yet another agent.
4. **Channel + agent CRUD UI** ✓ — in-browser create / edit /
   disable / archive via modal forms. Live cross-tab sync via
   `state_changed` WS events. ADR-0007.
5. **Markdown export** — *not yet*. Today: query SQLite directly,
   tracked as part of the log/transcript surface (issue #2).

## What this is **not** doing

* **Authentication.** Single-user local tool. Adding auth is its own
  ADR (planned for when finn moves off the Mac+VM trust domain).
* **Agent-to-agent direct connectors.** Everything goes through the
  UI. By design.
* **Streaming responses.** Messages return whole. Token-streaming
  is planned for the WebSocket-side once the rest of the data model
  is stable.
* **Files, images, voice.** Future ADRs.
* **Cross-channel search.** Comes with the log viewer, later.

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

Tracked as open GitHub issues:

* **#2** Log/transcript surface — browse, search, mark, export.
  Next-up after CRUD.
* **#4** Mention autocomplete in the message composer.
* **#1** Discovery: rich-rendering for message bubbles
  (Markdown? something else?).
* **#3** Discovery: token-streaming for assistant replies.
* **#6** Discovery: where session memory lives
  (finn ↔ agent ↔ user).

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
