# finn — connectors and providers

Each agent in finn is bound to one **connector** that knows how to
turn an inbound message into a reply. Today there are three
connector types in the codebase:

| Connector type      | What it does                                                          | Use it for                                                                              |
| ------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `openclaw`          | POSTs to an OpenClaw Gateway's OpenAI-compatible endpoint, with OpenClaw-specific headers (agent routing, scopes, session keys). | Talking to one or more agents living inside an OpenClaw gateway you control.            |
| `openai-compatible` | POSTs to *any* `/chat/completions` endpoint that speaks vanilla OpenAI — no OpenClaw-specific headers. | Talking to a backend that's its own product (Wintermute, Open WebUI, vLLM, llama.cpp, …). |
| `anthropic-stub`    | Returns canned replies.                                               | Dev/test only. Never talks to the network.                                              |

The `openclaw` connector is the workhorse for OpenClaw-hosted
agents. The `openai-compatible` connector covers everything else
that speaks the OpenAI Chat Completions wire. Both are real,
network-touching paths; the choice between them is which kind of
backend you're talking to, not whether you trust OpenAI more.

> A real `anthropic` connector (talking to Anthropic's API directly,
> bypassing OpenClaw) is on the roadmap but not yet shipped. Until
> then, "use Anthropic Claude" means "configure OpenClaw to know your
> Anthropic key, then use the `openclaw` connector".

---

## What goes in the `model` field (openclaw connector)

*This section is openclaw-connector specific.* The
`openai-compatible` connector has a separate `model_hint` field
with different semantics; see [Scenario C](#scenario-c-openai-compatible-backend)
for that one.

The finn agent's `model` field is forwarded as-is to OpenClaw's
OpenAI-compatible endpoint. OpenClaw treats this field as an
**agent target**, not as a raw provider/model id (see the upstream
[OpenAI HTTP API docs](https://docs.openclaw.ai/gateway/openai-http-api)).
The accepted forms:

| `model` value                | Routes to                                  | Inference model                      |
| ---------------------------- | ------------------------------------------ | ------------------------------------ |
| `openclaw`                   | OpenClaw's **default** agent               | The default agent's configured model |
| `openclaw/default`           | Same as `openclaw` (stable alias)          | Default agent's configured model     |
| `openclaw/<agentId>`         | The named OpenClaw agent (`<agentId>`)     | That agent's configured model        |

The `<agentId>` form is what you want for **multi-agent setups**
where each agent has its own workspace, identity, memory, and
tools. Example: an OpenClaw install with `dixie` (Anthropic, primary
assistant) and `gwen` (local Ollama, scratch model) — a finn agent
that should reach Gwen sets `model: openclaw/gwen`.

For a **per-call backend-model override** (e.g. force the selected
agent to run this turn against a different provider/model), use the
separate `x-openclaw-model` HTTP header. Today finn does **not** set
this header from the agent CRUD UI; if you need it, see the
*"Connector model override"* discovery issue (filed as a follow-up to
this guide). Do **not** put a raw provider/model id into the `model`
field — OpenClaw will reject it with a 400 (`Invalid model. Use openclaw
or openclaw/<agentId>`).

The seed defaults to `model: openclaw` (default agent, default
model) — see `scripts/seed.ts`.

### Session continuity: how finn pins OpenClaw sessions

finn pins one OpenClaw-side session per (agent, channel) pair
via an `x-openclaw-session-key` header. The exact shape depends
on whether the agent's `model` field names a specific agent and
whether the optional `session_override` is set:

| Agent's `model`             | `session_override` | Session-key sent                          | ADR     |
| --------------------------- | ------------------ | ----------------------------------------- | ------- |
| `openclaw`                  | (empty)            | `finn:<channel_id>`                       | 0002    |
| `openclaw/default`          | (empty)            | `finn:<channel_id>`                       | 0002    |
| `openclaw/<agentId>`        | (empty)            | `agent:<agentId>:finn:<channel_id>`       | 0012    |
| `openclaw/<agentId>`        | `<name>`           | `agent:<agentId>:<name>` (flat)           | 0017    |

**Default-agent + override is unsupported**: finn does not know
the gateway's currently-configured default-agent name (and
deliberately so — see ADR-0012's *"Why two shapes, not one"*),
so it cannot construct a stable session-key for that combination.
The agent CRUD form rejects this combination inline; the connector
rejects it at call time with an error referencing ADR-0017.

#### When to use `session_override`

Use the override when you want **the same upstream agent to
maintain one conversation across all finn channels using it**,
or when you want the upstream session to be **shareable with a
non-finn OpenClaw client** (the TUI, a webchat, another tool) by
using the same session name on both sides.

Use the default (no override) when you want **per-channel
isolation**, i.e. each finn channel hosts its own conversation
thread with this agent.

#### Worked example: multiple session-variants of one upstream agent

Want to address Dixie from finn under a `finn` session, while
your OpenClaw TUI talks to the same Dixie under the default
`main` session? Register two finn agents that point at the same
upstream:

| finn agent name | `model`            | `session_override` | Session-key sent          |
| --------------- | ------------------ | ------------------ | ------------------------- |
| `dixie`         | `openclaw/dixie`   | *(empty)*          | `agent:dixie:finn:c_X`    |
| `dixie-finn`    | `openclaw/dixie`   | `finn`             | `agent:dixie:finn`        |

The `dixie` agent gives you ADR-0012's per-channel isolation
(each finn channel is its own conversation). The `dixie-finn`
agent gives you a single shared upstream `finn` session that
spans every finn channel `dixie-finn` is a member of — and that
you can also reach from the OpenClaw TUI as session `finn`.

This is the design called out in ADR-0017 as "session is a
property of the agent, not the channel." Different sessions =
different conversation partners (shared persona, distinct memory
windows) modelled as distinct agent-registry rows.

---

## Picking a scenario

Four deployment shapes cover most needs. Pick the one that matches
what you have, then jump to the matching section below.

### Scenario A — Anthropic Cloud via OpenClaw

You have an Anthropic API key. You want Claude (Sonnet/Opus) replies
in finn. Inference runs at Anthropic.

- finn agent: `connector_type: openclaw`
- finn agent `model`: `openclaw` (use the default OpenClaw agent and
  its default model — typically `anthropic/claude-opus-4-7`)
- OpenClaw Gateway: needs Anthropic provider configured + the API key
  in the gateway's auth profile, **and** the default agent must have
  an Anthropic model id as its `model.primary`

This is the simplest path and what the seeded `dixie` agent in
`scripts/seed.ts` uses out of the box.

### Scenario B — local Ollama on the Mac host

You run Ollama on your Mac (or another machine on your LAN). You want
finn to talk to a local model — for privacy, offline use, or because
you have heavyweight hardware sitting around. Inference runs on your
own GPU/CPU.

Two sub-shapes depending on where finn lives:

- **B.1** — finn runs as a containerised process on the Mac
  (OrbStack / Docker Desktop), Ollama also on the Mac. The container
  reaches Ollama via `host.docker.internal`. Ollama can stay on
  loopback (`127.0.0.1`); nothing is exposed beyond the Mac.
- **B.2** — finn runs in a VM (UTM, Lima, …) or on a different host.
  The VM/host reaches Ollama via the Mac's bridge IP
  (e.g. `192.168.64.1` for UTM Shared Network). Ollama needs to bind
  to that interface, not just loopback.

In both cases, OpenClaw still mediates the call — finn talks to
OpenClaw, OpenClaw talks to Ollama. This keeps tool calling, session
keys, and fallback routing working.

The Ollama-backed persona has to live on the OpenClaw side as a
**dedicated agent**. Register a separate OpenClaw agent (e.g. `gwen`)
with its own workspace and a default model that points at the
Ollama provider (`ollama-mac/qwen3.6:latest`). The finn agent then
sets `model: openclaw/gwen` and OpenClaw routes the call to that
agent's workspace, memory, and Ollama-backed model.

*(There is no "just override the model on the default agent"
shortcut. The OpenAI HTTP endpoint rejects raw provider/model ids in
the `model` field with a 400. The supported override path is the
`x-openclaw-model` header, which finn does not yet expose in the
UI.)*

### Scenario C — OpenAI-compatible backend (Wintermute, Open WebUI, …)

You have a backend that exposes its own `/chat/completions`
endpoint speaking the OpenAI Chat Completions wire format. Examples:
Wintermute (see its `docs/OPENAI-COMPAT.md`), Open WebUI, LobeChat
in proxy mode, vLLM, llama.cpp's HTTP server, anything else with an
OpenAI-compatible facade.

- finn agent: `connector_type: openai-compatible`
- finn agent `base_url`: the backend's `/v1` URL
  (e.g. `https://agent.your-domain.example/v1`).
- finn agent `model_hint`: usually `default`. Backends that route
  on the `model` field need the backend-specific id.

This is a *thinner* path than `openclaw`: no OpenClaw-specific
headers, no agent routing, no session-key scheme. Conversation
continuity rides on OpenAI's standard `user` body field, set to the
finn channel id; backends that pin per-`user` sessions (Wintermute
does) get channel-scoped state for free, backends that don't simply
behave statelessly per turn.

### Scenario D — dev/test with the stub

You want to try the UI, the approval flow, or the protocol viewer
without paying for tokens or installing a model server. Use the
seeded `muse` agent. Replies are canned, deterministic, fast.

---

## Scenario A — Anthropic via OpenClaw

### Prerequisites

- An Anthropic API key (`sk-ant-...`).
- A running OpenClaw Gateway with the Anthropic plugin enabled.
- The gateway's bearer token (for finn's auth header).

### 1. Configure OpenClaw

If you ran `openclaw onboard` and picked Anthropic, this is already
done. Otherwise:

```bash
openclaw config set plugins.entries.anthropic.enabled true
# Then add the Anthropic key to the auth profile that openclaw
# expects — `openclaw onboard` is the supported way; manual editing
# of openclaw.json or auth-profiles.json is possible but not the
# blessed path.
openclaw gateway restart
```

Verify:

```bash
openclaw models list --provider anthropic
# expect at least one anthropic/... entry
```

### 2. Configure the finn agent

In the finn agent CRUD UI (or seed file), set:

- `connector_type`: `openclaw`
- `base_url`: your OpenClaw gateway's OpenAI-compatible URL
  (e.g. `http://127.0.0.1:18789/v1` for one-machine setups,
  `http://192.168.64.2:18789/v1` for a VM-side gateway).
- `model`: `openclaw` (default agent) — or `openclaw/<agentId>` if
  the gateway has multiple OpenClaw agents and you want a specific
  one. See [What goes in the `model` field](#what-goes-in-the-model-field)
  for the supported forms and the session-key caveat.
- `token_env_var`: usually keep the default `FINN_OPENCLAW_API_KEY`.

The bearer token itself goes into `~/finn-data/secrets/.env` as
`FINN_OPENCLAW_API_KEY=...`. **Do not put it in the DB.**

### 3. Smoke test

Send any user message in the channel. The agent should reply within a
second or two. If you get `openclaw 401`, the token is wrong or the
env var is not loaded; check `~/finn-data/secrets/.env` and restart
finn.

---

## Scenario B — local Ollama via OpenClaw

### Prerequisites

- Ollama installed on the Mac (or another LAN host) with at least one
  model pulled (`ollama pull qwen3.6` etc.).
- A running OpenClaw Gateway.

### 1. Decide how OpenClaw will reach Ollama

Where is the OpenClaw Gateway running, and where is Ollama?

| Gateway location           | Ollama bind address                    | OpenClaw `baseUrl`                        |
| -------------------------- | -------------------------------------- | ----------------------------------------- |
| Same machine as Ollama     | `127.0.0.1:11434` (default)            | `http://127.0.0.1:11434`                  |
| In an OrbStack/Docker container on the same Mac | `127.0.0.1:11434` (default) | `http://host.docker.internal:11434`       |
| In a UTM VM on the same Mac                     | bind to bridge IP, e.g. `192.168.64.1:11434` | `http://192.168.64.1:11434`         |
| On a different host via LAN                     | `0.0.0.0:11434` + firewall rule | `http://<lan-ip>:11434`                   |

> ⚠️ Avoid `0.0.0.0:11434` without a firewall rule. Ollama has no
> built-in auth; anyone routable to the port can use your model.

To rebind Ollama on macOS to a specific interface, set `OLLAMA_HOST`
before starting the Ollama app:

```bash
launchctl setenv OLLAMA_HOST "192.168.64.1:11434"
# then quit and reopen the Ollama app, or restart `ollama serve`
```

Verify from the gateway side:

```bash
curl -sS http://<chosen-baseurl>/api/tags | jq '.models[].name'
```

### 2. Register Ollama as a provider in OpenClaw

Pick a provider id like `ollama-mac` (avoid the bare name `ollama`
when the gateway runs on a different host than Ollama — the bare name
triggers loopback auto-discovery, which will fail). Patch the
gateway config:

```json5
{
  "plugins": {
    "entries": {
      "ollama": { "enabled": true }
    }
  },
  "models": {
    "mode": "merge",
    "providers": {
      "ollama-mac": {
        "baseUrl": "http://192.168.64.1:11434",
        "api": "ollama",
        "apiKey": "ollama-local",
        "models": [
          {
            "id": "qwen3.6:latest",
            "name": "Qwen 3.6 (Mac)",
            "input": ["text"],
            "reasoning": false,
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
          }
        ]
      }
    }
  }
}
```

Notes:

- `apiKey: "ollama-local"` is OpenClaw's marker for trusted local
  endpoints (loopback, private LAN, `.local`, bare hostname). It is
  not a real secret. Public hosts must use a real key.
- List each model you want to expose. The id must match what
  `ollama list` shows on the Mac.
- `models.mode: "merge"` keeps existing providers (e.g. Anthropic) in
  place. Without it, you replace the entire models block.

Restart the gateway:

```bash
openclaw gateway restart
openclaw models list --provider ollama-mac
```

Smoke-test the local route end to end (no agent surface, just the
model):

```bash
openclaw infer model run --local \
  --model ollama-mac/qwen3.6:latest \
  --prompt "Reply with exactly: pong" --json
```

You should see `"text": "pong"`. The first call may take several
seconds while Ollama loads the model into memory; subsequent calls
are fast.

### 3. Register an OpenClaw agent for the local-model persona

The local-model persona has to live on the OpenClaw side as a
dedicated agent. Register it with its own workspace and Ollama as
the default model:

```bash
openclaw agents add gwen \
  --workspace ~/.openclaw/agents/gwen/workspace \
  --model ollama-mac/qwen3.6:latest \
  --non-interactive
```

The workspace directory is the agent's home — populate it with the
usual `IDENTITY.md`, `SOUL.md`, `AGENTS.md`, `USER.md` for the new
persona before or after the `agents add`. The agent's auth profile
store is created lazily on first run; for a pure-Ollama agent, no
auth profiles are needed (the Ollama provider uses the
trusted-local marker).

Verify:

```bash
openclaw agents list
# expect both your default agent and the new one, each with its
# correct model.
openclaw agent --agent gwen --message "Reply with exactly: pong"
# expect a one-word reply via the local model. First call cold-loads
# the model into Ollama's RAM and may take 10–30s.

curl -sS http://<gateway-host>:<port>/v1/models \
  -H 'Authorization: Bearer ***'
# expect openclaw, openclaw/default, openclaw/<your-default>,
# openclaw/<new-agent> in the data list.
```

### 4. Configure the finn agent

In the finn agent CRUD UI (or seed file), set:

- `connector_type`: `openclaw`
- `base_url`: your gateway's OpenAI URL
- `model`: `openclaw/<agentId>`, e.g. `openclaw/gwen`. finn talks to
  that agent; the agent's own default model (the Ollama one)
  handles the turn.

Send a message in the channel. First reply may be slow (cold model);
following replies are fast.

> If the channel had already been talking to a different agent
> before you switched the `model` field, see the
> [session-key caveat](#caveat-agent-selection-vs-session-continuity).
> The quick fix today is to delete and recreate the channel.

### 5. (Sub-scenario B.1) finn in a container on the Mac

If finn itself runs as an OrbStack/Docker container on the same Mac
as Ollama, you can keep Ollama on `127.0.0.1:11434` (no exposure!)
and have **OpenClaw** also run as a container, with the provider
config using `http://host.docker.internal:11434`.

This is the strongest privacy posture: nothing listens beyond the Mac
itself.

> finn's container deployment story is still being shaped. The
> setup-mac.md guide currently assumes Node-on-host. If you go the
> container route ahead of us, please open an issue with what you did
> — we'll fold it into the docs.

---

## Scenario C — OpenAI-compatible backend

### Prerequisites

- A backend reachable over the network that exposes
  `POST /chat/completions` with OpenAI's wire format. Wintermute's
  `/v1/*` adapter is the reference implementation; the upstream
  contract is in its `docs/OPENAI-COMPAT.md`.
- A bearer token for the backend (or a way to disable auth on it,
  e.g. behind a private network).

### 1. Verify the backend speaks the wire

Before touching finn, smoke-test the backend directly:

```bash
curl -sS https://agent.your-domain.example/v1/models \
  -H 'Authorization: Bearer ***'
# expect: { "object": "list", "data": [ ... ] }

curl -sS https://agent.your-domain.example/v1/chat/completions \
  -H 'Authorization: Bearer ***' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "default",
    "messages": [{"role": "user", "content": "Reply with exactly: pong"}]
  }'
# expect: a chat.completion JSON with content "pong" (or close).
```

If either of these fails, fix it backend-side first. finn cannot
make a non-compliant backend look compliant.

### 2. Configure the finn agent

In the agent CRUD UI (or seed file), set:

- `connector_type`: `openai-compatible`
- `base_url`: the backend's `/v1` URL.
- `token_env_var`: a backend-specific name, e.g.
  `FINN_WINTERMUTE_API_KEY`. The token itself goes into
  `~/finn-data/secrets/.env`; **do not put it in the DB**.
- `model_hint`: `default` for backends that ignore the `model`
  field (Wintermute), or the backend-specific id for backends that
  route on it.

### 3. Smoke test

Send any user message in a channel that has the agent as a member.
The reply should arrive within a second or two for cloud-backed
backends; local-model backends may take 10–30s on first request as
the model loads.

If you get `openai-compatible 401`, the token env var is missing or
wrong; check `~/finn-data/secrets/.env` and restart finn.

### How this differs from the openclaw connector

finn sends:

```http
POST <base_url>/chat/completions
Authorization: Bearer ***
Content-Type: application/json

{
  "model": "<model_hint>",
  "user":  "<finn channel id>",
  "messages": [...],
  "stream": false
}
```

No `x-openclaw-scopes`, no `x-openclaw-session-key`, no `x-openclaw-agent-id`.
The backend gets a vanilla OpenAI request and is free to handle it
as it sees fit. Conversation continuity is the OpenAI-standard
`user` field; per-channel scoping happens because finn channel ids
are stable and unique.

### Worked example: pointing finn at Wintermute

Wintermute exposes its OpenAI-compatible adapter behind a TLS
reverse proxy (see Wintermute's `docs/OPENAI-COMPAT.md` for the
backend-side setup). On the finn side:

- `base_url`: `https://agent.your-domain.example/v1`
- `token_env_var`: `FINN_WINTERMUTE_API_KEY` (with the actual
  token in `~/finn-data/secrets/.env`).
- `model_hint`: `default` (Wintermute ignores the `model` field).

Make the agent a member of a channel and post a message. Wintermute
sees the request as a `chat.completion` from `user: <channel-id>`
and maps that to its own `conversation_id`, so each finn channel
gets its own continuity scope on Wintermute's side.

---

## Scenario D — dev/test stub

The `anthropic-stub` connector returns canned replies based on the
inbound message. It never makes a network call. Use it when:

- You're working on UI, approvals, mention parsing, or the protocol
  viewer and don't want real LLM latency or cost.
- You want a deterministic agent for tests.
- You want to demo finn somewhere without an API key.

The seeded `muse` agent in `scripts/seed.ts` uses this connector. Add
your own by setting `connector_type: anthropic-stub` in the agent
form; the config is just `{}`.

There is intentionally no setup. That's the point.

---

## Provider matrix (current state)

| Provider                          | Connector path                              | Status     | Notes                                                        |
| --------------------------------- | ------------------------------------------- | ---------- | ------------------------------------------------------------ |
| Anthropic (Claude) via OpenClaw   | `openclaw` → OpenClaw → Anthropic            | ✅ shipped | Recommended primary path for OpenClaw-hosted agents.         |
| Ollama local via OpenClaw         | `openclaw` → OpenClaw → Ollama               | ✅ shipped | Privacy / offline / hardware-rich, OpenClaw-mediated.        |
| OpenAI (GPT-x) via OpenClaw       | `openclaw` → OpenClaw → OpenAI               | ✅ shipped *if OpenClaw has the key* | Same shape as Anthropic.                  |
| Wintermute (OpenAI-compat)        | `openai-compatible` → Wintermute            | ✅ shipped | Wintermute's own `/v1/*` adapter; see its `docs/OPENAI-COMPAT.md`. |
| Other OpenAI-compat backends      | `openai-compatible` → Open WebUI / vLLM / … | ✅ shipped *should be* | Same wire as Wintermute; backend-specific config differs.    |
| Stub (dev/test)                   | `anthropic-stub`                            | ✅ shipped | No network.                                                  |
| Anthropic direct                  | `anthropic` (planned)                       | 🟡 planned | Bypasses OpenClaw.                                           |
| Ollama direct                     | `ollama` (planned)                          | 🟡 planned | For container-on-host with no gateway.                       |

"Direct" connectors are deferred; the OpenClaw-mediated path covers
the same use cases today, and the indirection is what gives you tool
calling, session keys, and fallback routing.

---

## Streaming status

**End-to-end streaming since PR #45 (ADR-0013 phases 2 + 3 in
full).** The dispatcher fans out user messages with
`streamUserMessage(args, emit)` and relays approved
agent-to-agent messages with `streamToAgent(args, emit)`. Both
drive a shared `streamOneAgent` helper that emits the same
lifecycle over the WebSocket:

  `message_start` → zero or more `message_delta` →
  `message_end` (clean) **or** `message_error` (mid-flight)

Clients render an empty agent bubble on `message_start`, append
on each `message_delta`, finalise on `message_end`, and switch
to an error variant on `message_error`. A small status icon
(● streaming, ✓ done, ⚠ errored) sits in the bubble header
for at-a-glance state. The full wire shape and client handling
are in ADR-0013.

Connector contract: each connector exposes a single `streamReply`
method returning `AsyncGenerator<SseEvent, void, void>` where
`SseEvent` is the discriminated union
`{ kind: 'delta'; text: string } | { kind: 'usage'; usage: UsageReport }`.
Deltas accumulate the body; the optional `usage` event (issue
#43 part B) is captured by the dispatcher and persisted as
`messages.tokens_json`. The non-streaming `send` path that
existed during the spike is gone — removed in the post-phase-3
sweep once both dispatcher entry points consumed the streaming
surface end-to-end.

Both HTTP connectors send
`stream_options: { include_usage: true }` on streaming requests
(PR #51). Without that flag, OpenAI-shaped backends *do not*
include the `usage` block in the SSE response — the stream
ends right after the last content delta. Backends that honour
the flag emit a final `choices: [], usage: {...}` frame just
before `[DONE]`; backends that ignore it (Wintermute today)
are unaffected, the footer stays hidden, no harm done.

Backend reality (see ADR-0013 §"Backend streaming maturity"):

- **OpenClaw → Anthropic**: real token-by-token (Anthropic SSE
  passes through). Reports `usage` on the final frame.
- **OpenClaw → Ollama (Gwen, etc.)**: real token-by-token (Ollama
  streams). Reports `usage` on the final frame.
- **Wintermute (`/v1/*`)**: today emits a single content delta
  carrying the full reply, then `[DONE]`. The wire contract is
  already correct; finn does not need to change when Wintermute's
  `agent.chat` upstream gains genuine streaming. Does **not**
  report `usage` today (LiteLLM token counts not passed
  through); the bubble's token footer stays hidden.
- **`anthropic-stub`**: yields the canned reply as a single chunk
  after a tiny artificial latency, mirroring Wintermute's shape
  so the dispatcher exercise path is representative without
  burning real API credits. Does not emit `usage` (a stub is not
  a real LLM call, fabricated counters would mislead).

The sequencing win applies even to backends that don't actually
stream: per-recipient streams run in parallel, so a fast agent's
bubble finishes while a slow agent's is still empty, and the
slowest agent never blocks the rest of the channel.

### Bubble rendering

Message bodies are rendered as Markdown (GFM with soft line
breaks) in the channel view, sanitised by DOMPurify. The
rendering pipeline is uniform for user and agent bubbles — the
sanitiser is the safety control, not the source. System messages
stay plain.

During streaming, bodies show as plain text plus a blinking
cursor; on `message_end` the body re-renders through the
Markdown pipeline (“plain-while-streaming, finalised on end”).
No syntax highlighter today — fenced code blocks just get a
monospace block treatment with internal `pre` whitespace.

**Mermaid diagrams.** Fenced code blocks with the language
token `mermaid` are rendered as actual SVG diagrams in the
bubble, not as monospace source. The renderer kicks in on
`message_end` (mid-stream content is almost always unparseable;
the bubble stays as a code block until the message settles).
If the source fails to parse, the bubble falls back to the
code-block render with a small inline error caption — the user
sees the source either way.

Example:

```text
```mermaid
graph TD
  A[start] --> B{question}
  B -->|yes| C[ok]
  B -->|no|  D[stop]
```
```

Mermaid runs in `securityLevel: 'strict'` mode and the rendered
SVG passes through a second DOMPurify pass with an explicit
SVG allowlist. Connector authors do not need to escape anything
special in the source — finn does the label-escape pass before
handing the source to Mermaid. The strict mode does disable
HTML labels, which means **no automatic text wrapping inside
node labels**; long labels overflow visually. Use `<br>` or
multiple short labels if wrap-shaped output matters.

See [`docs/decisions/0016-rich-rendering.md`](decisions/0016-rich-rendering.md)
for the full sanitiser policy and
[`docs/decisions/0022-mermaid-rendering.md`](decisions/0022-mermaid-rendering.md)
for the Mermaid-specific pipeline and security rationale.

## Routing modes (where the connectors get called from)

Four places in the server call into a connector. All of them
drive the same per-agent streaming pipeline
(`streamOneAgent` in `registry.ts`); they only differ in
*which agents* are recipients and *what triggers the call*.

| Trigger                              | Entry point          | Recipient set                                                  |
| ------------------------------------ | -------------------- | -------------------------------------------------------------- |
| User types a message in a channel    | `streamUserMessage`  | All enabled channel members, narrowed by `@-mentions` if any.  |
| User approves a pending mention      | `streamToAgent` (×N) | The targets the user committed to in the approval picker.       |
| User clicks ↗ forward on a bubble    | `streamToAgent` (×N) | The targets the user picked in the inline forward picker.       |
| (Hypothetical) Internal scheduler    | n/a                   | None today; finn never calls connectors without a user trigger. |

The approval flow (ADR-0005) gates the second row; the user-
triggered forward (ADR-0014) is the second legitimate routing
shape and skips the `pending` stage — the user's deliberate
click *is* the human-in-the-loop. No autonomous /
scheduler-driven path exists today; if it ever does, it gets
its own ADR.

---

## Troubleshooting

**`openclaw 401` from finn.** Bearer token wrong or env var not
loaded. Check `~/finn-data/secrets/.env` for `FINN_OPENCLAW_API_KEY`,
and that the gateway has the same token in
`~/.openclaw/openclaw.json` under `gateway.auth.token`. Restart finn
after editing the env file.

**`openclaw 400 Invalid model. Use openclaw or openclaw/<agentId>`.**
The `model` field in your finn agent's config holds a raw
provider/model id (e.g. `anthropic/claude-opus-4-7` or
`ollama-mac/qwen3.6:latest`). The OpenAI HTTP endpoint only accepts
agent targets there, not raw provider ids. Use `openclaw` or
`openclaw/<agentId>` — see [What goes in the `model`
field](#what-goes-in-the-model-field). For per-call backend overrides
the upstream surface is `x-openclaw-model`, which finn does not yet
set.

**`openclaw 404 model not found`.** The `<agentId>` in
`openclaw/<agentId>` does not exist on the gateway. Run
`openclaw agents list` on the gateway host or
`curl /v1/models -H 'Authorization: Bearer ***'` to see the
available agent targets.

**Reply comes back as the wrong persona.** Most likely the channel
has an existing OpenClaw-side session bound to the old agent and
the session-key wins over the `model` field's `openclaw/<agentId>`
suffix — see [the session-key caveat](#caveat-agent-selection-vs-session-continuity).
Quick workaround until the agent-aware session-key fix lands: delete
the channel and recreate it.

**`openclaw 401` after rotating the gateway token.** finn caches
nothing, but the env file may not have been re-read. Update
`~/finn-data/secrets/.env` and restart finn. Also update
`gateway.auth.token` in `~/.openclaw/openclaw.json` and run
`openclaw gateway restart`. The two values must match exactly.

**Local Ollama call hangs / times out.** OpenClaw cannot reach the
Ollama host. From the gateway machine, run
`curl http://<baseurl>/api/tags`. If that fails, your bind address or
firewall is the problem, not OpenClaw.

**First reply slow, later replies fast.** Ollama lazy-loads models
into RAM/VRAM on first request. Expected. To pre-warm, hit
`/api/generate` with a one-token prompt before serving real traffic.

**Tool calling produces raw JSON instead of running tools.** Some
local models emit tool calls as text rather than structured
invocations. This is a model/server limitation, not finn or OpenClaw.
For finn's current scope (chat routing, no agent tool surface) this
usually doesn't matter — but if you need it, see OpenClaw's
[local models guide](https://docs.openclaw.ai/gateway/local-models).

---

## See also

- [`setup.md`](setup.md) — single-machine setup
- [`setup-mac.md`](setup-mac.md) — Mac host + VM gateway setup
- [`decisions/0001-openclaw-connector-auth.md`](decisions/0001-openclaw-connector-auth.md) — auth model
- [`decisions/0002-session-key-format.md`](decisions/0002-session-key-format.md) — session continuity
- [OpenClaw OpenAI HTTP API](https://docs.openclaw.ai/gateway/openai-http-api) — the upstream contract this connector targets
- [OpenClaw provider docs](https://docs.openclaw.ai/providers/) — the source of truth for what OpenClaw can route to
