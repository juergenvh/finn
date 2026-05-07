# finn — local setup

Quick guide for a fresh machine. Walks from `git clone` to a running
finn with two agents and an approval flow you can poke at.

If anything below contradicts the source of truth, the source of truth
is the relevant ADR in `docs/decisions/`. Open an issue or update the
guide.

## Prerequisites

| Tool          | Verified version | Notes                                                    |
| ------------- | ---------------- | -------------------------------------------------------- |
| Node.js       | 24.x             | Older versions may work, not tested.                     |
| npm           | 11.x             | Bundled with Node. `pnpm`/`yarn` should also work.       |
| OpenClaw      | 2026.5+          | Optional but recommended — finn talks to it by default.  |
| sqlite3 CLI   | any              | Optional, for inspecting the DB.                         |

You also need the OpenClaw Gateway's bearer token if you want the
OpenClaw connector to work (the seeded `dixie` agent uses it). The
seeded `muse` agent is a stub and works with no key.

## 1. Clone and install

```bash
git clone https://github.com/juergenvh/finn.git
cd finn
npm install
```

## 2. Set up the data volume and secrets

Per ADR-0001 §"Token storage", finn keeps secrets *outside* the repo
in `~/finn-data/secrets/.env`. The `~/finn-data/` tree also holds the
SQLite database and (later) markdown exports.

```bash
mkdir -p ~/finn-data/secrets ~/finn-data/exports
chmod 700 ~/finn-data/secrets
```

Create `~/finn-data/secrets/.env` with your OpenClaw token:

```bash
cat > ~/finn-data/secrets/.env <<EOF
FINN_OPENCLAW_API_KEY=<your-openclaw-gateway-token>
EOF
chmod 600 ~/finn-data/secrets/.env
```

To find your gateway token, on a machine where you run OpenClaw:

```bash
python3 -c "import json; print(json.load(open('$HOME/.openclaw/openclaw.json'))['gateway']['auth']['token'])"
```

> If you do **not** have OpenClaw running, you can still run finn
> with only the `muse` (stub) agent. Talking to the `dixie` agent in
> the `spike` channel will fail with a network error until the token
> is in place. The `salon` channel still works because muse is a
> stub.

## 3. Enable OpenClaw's OpenAI-compatible HTTP endpoint

The OpenClaw connector uses `POST /v1/chat/completions`, which is
**disabled by default** on the gateway. Enable it once:

```bash
echo '{"gateway":{"http":{"endpoints":{"chatCompletions":{"enabled":true}}}}}' \
  | openclaw config patch --stdin
openclaw gateway restart
```

Verify:

```bash
TOKEN=$(python3 -c "import json; print(json.load(open('$HOME/.openclaw/openclaw.json'))['gateway']['auth']['token'])")
curl -sS http://127.0.0.1:18789/v1/models \
  -H "authorization: Bearer $TOKEN" | head -20
```

You should see at least `openclaw/default` in the model list.

## 4. Migrate the database and seed initial data

```bash
npm run db:migrate
npm run db:seed
```

The migration creates the schema; the seed creates two agents
(`dixie` via OpenClaw, `muse` via the stub connector) and two
channels (`spike` 1:1 with dixie, `salon` multi-agent with both).

The seed is **idempotent** — re-running it does not duplicate rows.
It is also **first-write-wins** for the `dixie` agent's config: the
row's `base_url` is fixed at first insert. If you ever need to
point `dixie` at a different gateway, edit the row directly:

```bash
sqlite3 ~/finn-data/finn.db \
  "UPDATE agents
   SET config = json_set(config, '\$.base_url', '<new-url>')
   WHERE name = 'dixie';"
```

Verify the seeded config:

```bash
sqlite3 ~/finn-data/finn.db \
  "SELECT name, json_extract(config, '\$.base_url') FROM agents;"
```

## 5. Run finn

For development (with HMR):

```bash
npm run dev
```

Open http://127.0.0.1:5173 and you should see the finn UI with the
two seeded channels.

For a production-style build:

```bash
npm run build
npm run start
# now serving on http://127.0.0.1:3000 (PORT/HOST overridable)
```

## 6. Try the approval flow

1. Open the `salon` channel from the sidebar.
2. Send any message — the user message fans out to both agents
   (`dixie` and `muse`) without approval, because user-originated
   messages are already human-decided (ADR-0005 §1).
3. `muse` is a stub that round-robins through canned replies.
   One of them mentions `@dixie`. When that one fires, you'll see
   the message bubble light up with a yellow `pending` badge,
   target checkboxes, and Approve / Reject buttons.
4. Click **Approve** to relay the message to `dixie`. The badge
   transitions yellow → blue (`approved`) → green (`routed`), and a
   new agent reply appears in the channel — that's `dixie`
   responding to the relayed message.
5. Click **Reject** instead and the bubble goes red, no relay.

Per ADR-0005, this human-gated relay is the *whole point* of finn —
agents speak in the channel freely, but cross-agent traffic always
pauses for explicit human approval. There is no auto-approve.

## 7. Inspect the database (optional)

The data lives at `~/finn-data/finn.db`:

```bash
sqlite3 ~/finn-data/finn.db ".tables"
sqlite3 ~/finn-data/finn.db "SELECT id, name FROM channels;"
sqlite3 ~/finn-data/finn.db "SELECT id, sender_type, substr(body,1,60) FROM messages ORDER BY created_at LIMIT 10;"
sqlite3 ~/finn-data/finn.db "SELECT id, status, decided_at FROM approvals ORDER BY created_at;"
```

Per ADR-0004, `messages` and `approvals` are append-only at the
application level. To genuinely remove rows, you do it here, with
finn stopped.

## Troubleshooting

### `bootstrap failed: /api/channels 500`

Usually means the database hasn't been migrated. Run
`npm run db:migrate && npm run db:seed`.

### `connector error: openclaw 404: Not Found`

The gateway is up but the OpenAI HTTP endpoint isn't enabled. See
step 3.

### `connector error: openclaw 401`

Wrong or missing bearer token. Check `~/finn-data/secrets/.env`.

### `dispatch error: agent <id> error: ...`

The connector for that specific agent failed. Other agents in the
channel still completed; their replies are above the error line in
the chat. Check the agent's `connector_type` and `config` in the DB.

### Port 5173 already in use

Something else is running there. Either stop it, or pass a different
port: `npm run dev -- --port 5180`.

## What's next

Once finn runs locally, the things you can do without code changes:

- Add new channels via `INSERT INTO channels`. (CRUD UI is on the
  roadmap.)
- Add new agents via `INSERT INTO agents` with a valid `config` JSON
  for the connector type.
- Inspect approvals: `SELECT * FROM approvals;`

Things still on the roadmap:

- Channel/agent CRUD UI (today: edit the DB)
- Real Anthropic connector (today: stub only)
- Markdown export to `~/finn-data/exports/`
- Server-bind to non-loopback (today: dev binds 127.0.0.1, prod binds
  0.0.0.0 but auth-mode migration per ADR-0001 follow-up is needed
  before that should be reachable from another machine)

See the `docs/decisions/` directory for the why-it-is-this-way of any
of the above.
