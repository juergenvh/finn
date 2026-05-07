# finn — Mac host setup (talking to a remote OpenClaw gateway)

Step-by-step for installing finn on a macOS host while the OpenClaw
gateway runs elsewhere — typically in a UTM VM on the same Mac.

This is the "two-machine" deployment. For "one-machine" (gateway and
finn both on the same host), see [`setup.md`](setup.md).

The two guides are intentionally redundant — pick the one that
matches your topology and follow it end to end. They diverge mainly
in step 2 (gateway bind) and step 3 (finn config).

## Topology assumed by this guide

```
┌────────────────────┐                ┌──────────────────────┐
│   macOS host       │                │   UTM VM (Linux)     │
│                    │  192.168.64.0  │                      │
│   finn (Node)      │ ◄────────────► │  openclaw-gateway    │
│   localhost:5173   │   /24 bridge   │  :18789  (lan bind)  │
│                    │                │                      │
│   ~/finn-data/     │                │  ~/.openclaw/...     │
└────────────────────┘                └──────────────────────┘
```

UTM's Shared Network mode places the VM on a private bridge
(`192.168.64.0/24` by default; the Mac is `192.168.64.1`, the VM
gets a DHCP address such as `192.168.64.2`). Other LAN devices
cannot route into this network — it is private to the Mac.

The Mac and the VM are therefore inside one trust domain for the
duration of this setup. See ADR-0001 §"Addendum 2026-05-07" for the
implications and the migration target.

## Prerequisites on the Mac

| Tool             | Verified version | Notes                                                     |
| ---------------- | ---------------- | --------------------------------------------------------- |
| Node.js          | 25.x             | 24.x also tested in the VM. ESM + Web Streams required.   |
| npm              | bundled          | `pnpm` / `yarn` should also work.                         |
| Xcode CLT        | any              | needed for `better-sqlite3` to compile native bindings.   |
| sqlite3 CLI      | any              | optional, for inspecting the DB.                          |

Verify Xcode Command Line Tools (one-time install if missing):

```bash
xcode-select -p   # should print a path; if not, run: xcode-select --install
```

## Prerequisites on the VM

The OpenClaw gateway must be:

1. **Running.** `openclaw gateway status` should show `state active`.
2. **Bound to a non-loopback interface** so the Mac can reach it.
   Default is `loopback` (= `127.0.0.1`), which is unreachable from
   the Mac. Switch:

   ```bash
   echo '{"gateway":{"bind":"lan"}}' | openclaw config patch --stdin
   openclaw gateway restart
   ```

   `lan` listens on all interfaces (`0.0.0.0`); `tailnet` is the
   alternative if you run Tailscale.

3. **OpenAI HTTP endpoint enabled.** Once per VM:

   ```bash
   echo '{"gateway":{"http":{"endpoints":{"chatCompletions":{"enabled":true}}}}}' \
     | openclaw config patch --stdin
   openclaw gateway restart
   ```

Verify the gateway is reachable from the VM **on its bridge IP**
(not just loopback):

```bash
# On the VM:
ip -4 addr show | grep 'inet 192'
# Note the address (e.g. 192.168.64.2). That's $VM_IP below.
curl -sS http://$VM_IP:18789/v1/models \
  -H "authorization: Bearer $(python3 -c 'import json; print(json.load(open("/home/dixie/.openclaw/openclaw.json"))["gateway"]["auth"]["token"])')" \
  | head
```

You should see `openclaw/default` etc. in the response.

## 1. Verify Mac → VM reachability

Before installing finn, check the network path. On the Mac:

```bash
# Replace 192.168.64.2 with your VM's actual IP.
curl -sS -m 5 http://192.168.64.2:18789/v1/models
```

Expected outcomes:

- `{"error":{"message":"Unauthorized"...}}` — **good.** The gateway
  is reachable and is doing auth; the auth fails because no token.
- `Connection refused` — gateway bind didn't take effect, or wrong
  port. Re-do the VM step 2.
- `Operation timed out` — UTM network mode is not Shared, or there
  is a firewall in the way. Check UTM → VM settings → Network →
  "Network Mode" should be "Shared Network".

Stop here if the path doesn't work. Everything below assumes it does.

## 2. Get the gateway bearer token

The token lives on the VM. Two options:

**Option A: print it on the VM and copy it across.**

```bash
# On the VM:
python3 -c "import json; print(json.load(open('/home/dixie/.openclaw/openclaw.json'))['gateway']['auth']['token'])"
```

Copy the output into your clipboard.

**Option B: read it via SSH from the Mac.**

```bash
# On the Mac, only if you have SSH access to the VM:
ssh <vm-host> "python3 -c \"import json; print(json.load(open('/home/dixie/.openclaw/openclaw.json'))['gateway']['auth']['token'])\""
```

Either way, you now have the same string the VM uses internally.

> Token-storage discipline: the token gives full operator rights on
> that gateway. Treat it as a secret. The next step puts it in a
> 0600-permissioned file outside the repo.

## 3. Clone finn and install dependencies

```bash
cd ~/Repositories                # or wherever you keep your repos
git clone https://github.com/juergenvh/finn.git
cd finn
npm install
```

`npm install` will compile `better-sqlite3` natively for your Mac's
architecture. If you see warnings about deprecated build tools,
they are usually harmless; outright errors usually mean Xcode CLT
is missing (see prerequisites).

## 4. Set up the data volume

Per ADR-0001 §"Token storage", finn keeps secrets *outside* the
repo. On the Mac, the conventional location is the same as on
Linux: `~/finn-data/`.

```bash
mkdir -p ~/finn-data/secrets ~/finn-data/exports
chmod 700 ~/finn-data/secrets

cat > ~/finn-data/secrets/.env <<EOF
FINN_OPENCLAW_API_KEY=<paste-the-token-from-step-2>
FINN_OPENCLAW_BASE_URL=http://192.168.64.2:18789/v1
EOF
chmod 600 ~/finn-data/secrets/.env
```

Two notes:

- The `FINN_OPENCLAW_BASE_URL` value is the address used **at
  runtime** by the connector, *and* picked up by the seed script
  in step 6 to fill the agent row's `base_url` in the DB.
  Both reads happen for free; the same env var covers both.
- The `<paste-the-token-from-step-2>` placeholder must become the
  actual token string. There is no `<...>` syntax — the file is
  read literally.

## 5. Migrate the database

```bash
npm run db:migrate
```

This creates `~/finn-data/finn.db` with the schema. The DB file is
local to this Mac; the VM has its own gateway database at a
different location and the two are unrelated.

## 6. Seed initial data

> ⚠️ **Order matters here.** The seed reads
> `FINN_OPENCLAW_BASE_URL` from your environment **only at the time
> the agent row is first inserted**. If you run `npm run db:seed`
> before step 4 (env file in place) or in a shell that does not
> have the env loaded, the seed writes the loopback default into
> the DB and finn will try to reach a non-existent local gateway.
>
> If you have already seeded with the wrong URL, the symptom is a
> `connector error: fetch failed` system message in the chat. Fix
> with:
>
> ```bash
> sqlite3 ~/finn-data/finn.db \
>   "UPDATE agents
>    SET config = json_set(config, '\$.base_url', 'http://192.168.64.2:18789/v1')
>    WHERE name = 'dixie';"
> ```
>
> No finn restart is needed — the connector reads the agent config
> from the DB on every call.

```bash
npm run db:seed
```

Because `FINN_OPENCLAW_BASE_URL` is set in the env, the seeded
`dixie` agent gets `base_url=http://192.168.64.2:18789/v1` written
into its config, pointing at the VM gateway.

The seed is **idempotent**: re-running it does not duplicate rows.
But once a row exists, its `config` is not re-written by the seed
on later runs — the URL you write at first insert is the URL that
stays in the DB. To change it later, use the SQL above (or wait
for the agent-config CRUD UI on the roadmap).

Verify the seeded URL after running:

```bash
sqlite3 ~/finn-data/finn.db \
  "SELECT name, json_extract(config, '\$.base_url') FROM agents;"
```

The `dixie` row should show your VM URL, not loopback.

## 7. Run finn (foreground)

```bash
npm run dev
```

Open http://127.0.0.1:5173 in a browser. You should see the finn
UI with two seeded channels (`spike`, `salon`).

The `spike` channel sends straight to your VM's OpenClaw gateway —
that's the cross-machine test. `salon` works locally with the
`muse` stub regardless.

To stop: `Ctrl-C` in the terminal.

> **Why not launchd?**
>
> While finn is in active development (the spike phase), running it
> as a foreground process is correct: every code change wants a
> restart anyway, and `npm run dev` gives HMR. Once we cut a stable
> artefact, we will write a `~/Library/LaunchAgents/` plist; that is
> intentionally out of scope today.

## 8. Smoke test

In the `spike` channel, send: `was sind 2+2?`

If you see a real reply within a few seconds, the entire chain
works end to end:

- Mac → VM bridge route ✓
- VM gateway accepts the bearer token ✓
- Gateway routes to the configured default agent ✓
- Connector returns the reply ✓
- finn persists the message and broadcasts via WebSocket ✓
- UI renders it ✓

## Updating

```bash
cd ~/Repositories/finn
git pull
npm install                # picks up dependency changes
npm run db:migrate         # idempotent; applies any new migrations
npm run dev                # restart
```

The seed (`npm run db:seed`) is only needed once per fresh DB.
Re-running it is safe but does not pick up changes to the seed
script's defaults if the rows already exist.

## Troubleshooting (Mac-specific)

### `Error: Cannot find module 'better-sqlite3'` or native binding errors

`npm install` did not finish compiling. Try:

```bash
npm rebuild better-sqlite3
```

If that fails, you usually need Xcode Command Line Tools.

### Connector returns `401 Unauthorized`

The bearer token in `~/finn-data/secrets/.env` doesn't match what
the VM gateway expects. Re-do step 2; if you rotated the token on
the VM, update the file and restart finn.

### Connector returns `404 Not Found`

The VM gateway is up but the OpenAI HTTP endpoint is disabled.
Re-do prerequisite step 3 on the VM and restart the gateway.

### `Connection refused` from finn

The VM is up but the gateway is binding to loopback again, or the
restart didn't take. On the VM:

```bash
openclaw gateway status | grep Listening
```

Should print `*:18789`, not `127.0.0.1:18789`.

### VM IP changed after a reboot

UTM's DHCP usually keeps the same address, but not guaranteed. If
the VM's IP changes, update both:

- `~/finn-data/secrets/.env` (`FINN_OPENCLAW_BASE_URL`)
- the `dixie` agent row in the DB (see step 6 SQL)

To make this less fragile in the long run, a static lease in UTM
or hostname resolution via Bonjour/`.local` is the right answer.

## What this setup commits us to

- **Token in two places**, with two-host rotation cost. Documented
  in ADR-0001 §"Addendum 2026-05-07".
- **VM must be running** for finn to talk to the OpenClaw agent.
  The `salon` channel still works (stub agent), but `spike` errors
  out.
- **finn-on-Mac and finn-in-VM are independent** finn instances.
  They write to different `~/finn-data/finn.db` files; they do not
  share channels, messages, or approvals. Whichever one you use is
  the one with that history.

## Next: making it stick

Once this setup feels stable and you are no longer changing finn
several times a day, the natural next steps are:

1. **launchd integration:** a `~/Library/LaunchAgents/com.finn.plist`
   that runs `npm run start` (the production-style server.js path),
   restarts on crash, logs to `~/finn-data/logs/`. Out of scope
   today, but documented as a follow-up in the daily log.
2. **Auth mode migration on the VM:** switch the gateway from
   `token` mode to `trusted-proxy` with the Mac's UTM bridge IP as
   trusted source. See ADR-0001 for the migration sketch.
3. **Stable VM hostname:** static DHCP lease in UTM, or Bonjour
   resolution (`<vm-name>.local` typically resolves on macOS without
   extra setup).
