# finn — connectors and providers

Each agent in finn is bound to one **connector** that knows how to
turn an inbound message into a reply. Today there are two connector
types in the codebase:

| Connector type    | What it does                                              | Use it for                                    |
| ----------------- | --------------------------------------------------------- | --------------------------------------------- |
| `openclaw`        | POSTs to an OpenClaw Gateway's OpenAI-compatible endpoint | The default path. Routes through OpenClaw to any provider OpenClaw is configured for (Anthropic, Ollama, OpenAI, …). |
| `anthropic-stub`  | Returns canned replies                                    | Dev/test only. Never talks to the network.    |

The `openclaw` connector is the workhorse. By configuring **what
goes in the `model` field**, you steer both *which OpenClaw agent*
handles the turn and *which underlying model* runs the inference.
finn itself does not need to know about the providers; OpenClaw
resolves the model id and routes the call.

> A real `anthropic` connector (talking to Anthropic's API directly,
> bypassing OpenClaw) is on the roadmap but not yet shipped. Until
> then, "use Anthropic Claude" means "configure OpenClaw to know your
> Anthropic key, then use the `openclaw` connector".

---

## What goes in the `model` field

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

### Caveat: agent selection vs. session continuity

finn pins one OpenClaw-side session per channel via
`x-openclaw-session-key: finn:<channel_id>` (ADR-0002). On the
OpenClaw gateway, sessions are **agent-scoped** — once a given
session-key has been seen with one agent, the agent is bound to
that session and subsequent calls under the same session-key load
the bound agent regardless of the `model` field's `openclaw/<agentId>`
suffix. In practice: if a finn channel has ever talked to Dixie, then
later retargeted to Gwen via `model: openclaw/gwen`, the channel
will keep replying as Dixie until the session-key changes.

The planned fix is an agent-aware session-key format
(`finn:<agent>:<channel_id>`), so each `(agent, channel)` pair gets
its own OpenClaw session. Tracked as a follow-up to this guide;
until it lands:

- New finn channels with `model: openclaw/<agentId>` route correctly
  on first contact.
- Existing finn channels that have already talked to a different
  agent are stuck with the old agent until the session-key format
  changes (single-user pre-public; we delete and recreate).

---

## Picking a scenario

Three deployment shapes cover most needs. Pick the one that matches
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

### Scenario C — dev/test with the stub

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

## Scenario C — dev/test stub

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

| Provider                | Connector path                | Status     | Notes                                 |
| ----------------------- | ----------------------------- | ---------- | ------------------------------------- |
| Anthropic (Claude)      | `openclaw` → OpenClaw → Anthropic | ✅ shipped | Recommended primary path              |
| Ollama local (Mac/LAN)  | `openclaw` → OpenClaw → Ollama    | ✅ shipped | Privacy / offline / hardware-rich     |
| OpenAI (GPT-x)          | `openclaw` → OpenClaw → OpenAI    | ✅ shipped *if OpenClaw has the key* | Same shape as Anthropic               |
| Stub (dev/test)         | `anthropic-stub`              | ✅ shipped | No network                            |
| Anthropic direct        | `anthropic` (planned)         | 🟡 planned | Bypasses OpenClaw                     |
| Ollama direct           | `ollama` (planned)            | 🟡 planned | For container-on-host with no gateway |

"Direct" connectors are deferred; the OpenClaw-mediated path covers
the same use cases today, and the indirection is what gives you tool
calling, session keys, and fallback routing.

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
