# finn

> *"Finn? Talks to the dead, mostly."*
> — *Neuromancer*, William Gibson

A multi-agent chat UI with human-in-the-loop approval. One window, many
agents (LLM endpoints, agent frameworks, anything that speaks HTTP),
and a human routing every cross-agent message by hand. Named after
Gibson's Finn — the fixer who routes between the living and the
ROM-stored dead.

**Status:** design phase, MVP not yet built.

## What it is

A web UI, in a container, on the Mac host. Lets a single user (you)
chat with several agents from one place, and — when the user wants —
puts multiple agents in the same channel where they can address each
other. Every cross-agent message goes through an explicit Approve /
Reject step at the UI, so the human is structurally always in the
loop.

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

## Architecture (MVP)

```
                ┌─────────────────────────────────┐
                │  Browser: http://localhost:5173 │
                └────────────────┬────────────────┘
                                 │ WebSocket
                                 │
   ┌─────────────────────────────┴───────────────────────────────┐
   │              finn (SvelteKit, single container)             │
   │                                                              │
   │  ┌──────────┐  ┌──────────┐  ┌────────────────┐             │
   │  │ Frontend │  │ WS server│  │ REST API       │             │
   │  │ (Svelte) │◄─┤ (live)   │  │ (CRUD agents/  │             │
   │  │          │  │          │  │  channels)     │             │
   │  └──────────┘  └────┬─────┘  └───────┬────────┘             │
   │                     │                │                       │
   │            ┌────────┴────────────────┴───────┐               │
   │            │  Channel + Approval Engine      │               │
   │            └────────┬─────────────────────────┘               │
   │                     │                                         │
   │   ┌─────────────────┴─────────────────────────┐              │
   │   │         Connector Interface                │              │
   │   │  (sendMessage, getStatus, capabilities)    │              │
   │   └──┬─────────────────┬─────────────────┬────┘              │
   │      │                 │                 │                    │
   │  ┌───▼────────┐  ┌─────▼───────┐  ┌──────▼─────────┐          │
   │  │  OpenClaw  │  │  Anthropic  │  │   (future)     │          │
   │  │  Connector │  │  Connector  │  │   Wintermute,  │          │
   │  │  (HTTP)    │  │  (HTTP)     │  │   OpenAI,...   │          │
   │  └────────────┘  └─────────────┘  └────────────────┘          │
   │                                                                │
   │  ┌────────────────────────────────────────────┐               │
   │  │  SQLite (mounted from host)                │               │
   │  │  /data/finn.db                             │               │
   │  └────────────────────────────────────────────┘               │
   │                                                                │
   │  Volume: /data → ~/finn-data on host                          │
   └────────────────────────────────────────────────────────────────┘
```

### Stack

* **Frontend + backend in one repo:** SvelteKit (single deployable, BFF
  pattern matches the use case). Same stack as `juergenvh/xeelee`.
* **Persistence:** SQLite via Drizzle ORM. File-based, no extra service.
  Migrate to Postgres later if the log volume warrants it.
* **Container:** OrbStack on the Mac host. Single container, host-mount
  for the data volume.
* **Real-time:** WebSocket between browser and server. Connectors
  themselves use whatever protocol the target agent supports (HTTP for
  most).

### Why these choices

* **SvelteKit over the Wintermute Python stack:** Jürgen wanted
  exposure to Node/SvelteKit; the rest of the personal-AI stack stays
  Python. Also, this tool is much more *frontend* than *backend*, and
  Svelte fits that better.
* **SQLite over Postgres / Qdrant:** the log is append-only structured
  data, no semantic search, no high concurrency. SQLite is the right
  size.
* **WebSocket only between browser and server:** connectors target
  agents that may speak only HTTP. Lifting the WebSocket requirement
  to the server boundary keeps every connector independently
  implementable.

## Data model

Five tables. The first four are the core; the fifth (`approvals`) is
what makes the human-in-the-loop pattern explicit in the schema.

```sql
agents          -- configured endpoints
  id, name, connector_type, config_json, enabled, created_at

channels        -- rooms with 1..N agents
  id, name, description, created_at

channel_members -- which agents are in which channel
  channel_id, agent_id

messages        -- everything that's been written
  id, channel_id, sender_type (user|agent), sender_id,
  body, created_at, parent_message_id

approvals       -- the human-in-the-loop step
  message_id, status (pending|approved|rejected|sent),
  targeted_agent_ids (JSON array),
  reject_reason (nullable), decided_at
```

A separate `audit_log` table is *not* needed: `messages` joined with
`approvals` already records every byte sent, every routing decision,
every reject reason, with timestamps. Markdown export is a SELECT.

## Approval flow

1. An agent answers. The connector posts to the server, which
   `INSERT`s into `messages` and creates an `approvals` row with
   `status=pending`. The UI receives a push: "new message from X
   awaits approval."
2. User sees a preview, picks targets (pre-filled from `@-mentions`
   in the body, overridable), clicks Approve or Reject.
3. **Approve:** `status=approved`, then `sent`. Targeted agents get
   the message via their connectors.
4. **Reject:** `status=rejected`, optional `reject_reason` recorded.
   The message stays in the log for the user's audit trail but is
   never relayed.

User-originated messages skip the approval step — they're already
human-decided. The approval gate exists strictly to mediate
agent-to-agent traffic.

## Addressing model

* Default: a message from agent X to the user, in a one-on-one
  channel, needs no targeting decision. The user sees it, the user
  responds.
* Multi-agent channel: when X writes something with `@Y` in it, the
  approval UI pre-fills Y as the target. The user can override
  (add Z, drop Y, retarget entirely) before approving. **Mentions
  are convenience; user choice is authoritative.**

## What the MVP can do

In ascending order of test-case weight:

1. **One-on-one chat** (user ↔ one agent), with approve/reject and
   logging. Connector: OpenClaw via the OpenAI-compatible HTTP API.
2. **Anthropic connector** — second endpoint. Plain Claude, no agent
   wrapper. Lets the user 1:1-compare wrapped-agent vs raw-LLM
   behaviour.
3. **Multi-agent channel** — user, OpenClaw, and raw Claude in one
   room. `@-mentions`, targeted approval. *This is the point at which
   the concept earns its keep.*
4. **Agent-config CRUD UI** — add / edit / disable agents from the
   browser, no JSON-editing-and-restart.
5. **Markdown export** of any channel to `/data/exports/`.

What the MVP does **not** include:

* Authentication — single-user local tool.
* Agent-to-agent direct connectors — everything goes through the UI.
* Streaming responses — messages return whole.
* Files, images, voice.
* Search across channels (comes later, with the log viewer).

## Layout on disk

```
~/Repositories/finn/      # repo, mounted into the container
~/finn-data/              # persistent state, mounted into the container
  ├─ finn.db              # SQLite database
  ├─ secrets/             # API keys etc., gitignored entirely
  └─ exports/             # markdown exports for NotebookLM, etc.
```

Container mounts:
* `~/Repositories/finn → /app` (read-only is fine; live editing happens
  on the host)
* `~/finn-data → /data`

The repo never touches `~/finn-data`. Database file stays out of the
repo. Secrets stay out of the repo. Exports stay out of the repo.

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
- The bearer secret used during the transitional phase lives at
  `~/finn-data/secrets/.env` with `0600` permissions, outside the
  repository.

In the **current transitional posture**, gateways may still run in
`token` mode, in which case the scope header is ignored and finn
behaves as a full operator (same trust posture as the OpenClaw TUI on
the same host). The code is already written for the target posture;
the migration is a gateway-config task, not a finn change.

Full rationale, options considered, and migration plan: see
[`docs/decisions/0001-openclaw-connector-auth.md`](docs/decisions/0001-openclaw-connector-auth.md).

## What's deliberately *not* here

* **storm7.** This project has nothing to do with the storm7.de stack.
  No subdomain, no shared infrastructure, no overlap.
* **MCP / tool-use.** finn is a chat router, not an agent. Agents may
  have their own tools (and many will), but finn neither knows nor
  cares.
* **Agent memory.** The transcript log is *the user's* logbook,
  read by humans, not by agents. Connectors do not query it.

## Out of scope today, on the roadmap

* OpenClaw-Container connector (next after OpenClaw-CLI works)
* Wintermute connector
* Streaming responses
* Log viewer with search and filter
* Markdown export with channel-scoped output

## Provenance

This README, the architecture sketch, and the implementation are a
collaboration between Jürgen (project owner) and Dixie (sister-agent
of the OpenClaw-on-VM instance) on 2026-05-06. The conversation that
shaped the design happened in that day's session; the design
decisions are pinned here so they're not lost when sessions reset.
Commits are authored as Dixie with `Co-authored-by` for Jürgen so
GitHub provenance reflects both.

## Related projects

* `juergenvh/wintermute` — personal AI agent (Python, on Hetzner).
  Will get a finn-connector eventually but is not part of this stack.
* `juergenvh/openclaw-server` — storm7 deployment configs. Unrelated
  to finn; mentioned only so it's clear they don't share anything.
* `juergenvh/agenticframework` — the universal meta-framework. Also
  unrelated; finn is a tool, not a phase.
