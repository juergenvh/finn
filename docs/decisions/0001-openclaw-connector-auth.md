# ADR 0001 — OpenClaw connector authentication and scope model

- **Status:** accepted
- **Date:** 2026-05-07
- **Deciders:** Jürgen, Dixie
- **Supersedes:** —

## Context

finn is a chat router. Each connector targets one external endpoint;
the OpenClaw connector targets one OpenClaw Gateway via its
OpenAI-compatible HTTP API (`POST /v1/chat/completions`).

OpenClaw's authentication, per
`docs/gateway/openai-http-api.md`, supports several modes:

- **`token`** / **`password`** (shared-secret): a valid Bearer token
  proves possession of the gateway's operator credential. The Gateway
  treats the caller as a full owner/operator. The
  `x-openclaw-scopes` header is **ignored**.
- **`trusted-proxy`** (identity-bearing): an outer trusted source
  (e.g. a tailscale-source, a reverse proxy, or loopback if
  `allowLoopback=true`) authenticates the deployment boundary. The
  Gateway **honors** `x-openclaw-scopes` when present, otherwise falls
  back to the default operator scope set.
- **`none`** (open ingress, intended only behind private network):
  also honors `x-openclaw-scopes`.

The default operator scope set is:

```
operator.admin
operator.approvals
operator.pairing
operator.read
operator.talk.secrets
operator.write
```

A caller can narrow scopes by setting `x-openclaw-scopes` to a
subset, but only in the modes that honor the header.

## Constraints we want to satisfy

1. **No middleman agent.** finn is a frontend. We will not introduce
   a finn-specific OpenClaw agent that paraphrases the real agent —
   that would re-create the very inter-agent paraphrase risk we
   designed finn to avoid (human-in-the-loop is the verification
   layer, not a synthetic bot).
2. **finn must be reachable from multiple OpenClaw gateways**, not
   only the local one. Specifically, at least one agent will run on
   a separate Mac. Loopback-only binding on the gateway side is
   therefore not the long-term answer.
3. **finn must not silently inherit `operator.admin`** when the
   only thing it needs is to send a chat turn and receive a reply.
4. **The transition path must be visible in the code** — somebody
   reading `connectors/openclaw.ts` next month must be able to see
   that scoped authentication is the design intent, not an
   afterthought.

## Options considered

### Option A — Token mode + loopback bind only

- Gateway runs in `token` mode, listens only on `127.0.0.1`.
- finn calls with the operator token.
- finn ends up as full operator.

**Pros:** zero config change. Same trust posture as the OpenClaw TUI.
**Cons:** does not satisfy constraint (2) — cannot reach a gateway
on another machine. Forecloses the multi-gateway future.

**Rejected.**

### Option B — Trusted-proxy mode + tailscale (or equivalent) source trust + scoped headers

- Each gateway that finn talks to runs in `trusted-proxy` mode.
- The trusted source is a network-level identity (tailscale source IP
  for cross-machine, `allowLoopback=true` for local).
- finn always sends `x-openclaw-scopes` with a narrowed set
  (initially: `operator.read operator.write` — chat works,
  admin/approvals/pairing/secrets do not).
- The gateway honors the narrowed scope, so finn cannot escalate
  beyond its designed surface even if the finn process is compromised.

**Pros:** scales to multiple gateways. Real privilege boundary at the
gateway level. Header-based, so changing scopes later is a config
change, not a redeploy. Code reads as “finn is a scoped operator UI.”
**Cons:** requires changing the gateway auth mode on every gateway
finn talks to. Existing clients (TUI, webchat) need to keep working
across the auth-mode switch — that is a verification step, not just
a config edit.

**Accepted as the design target.**

### Option C — Defer the connector entirely; ship Echo-only today

- Wire the SvelteKit/WebSocket plumbing today, leave the OpenClaw
  connector for a future day.
- Decide auth then.

**Pros:** zero security surface today.
**Cons:** the auth question is fundamental — deferring it does not
resolve it, only postpones the same conversation. Also, leaving the
spike unable to actually talk to an agent removes the smoke-test
that proves the architecture works end-to-end.

**Rejected.**

## Decision

We pick **Option B as the design target**, and accept that today's
deployment will run in **Option A's posture** as a transitional
state.

Concretely:

- **Code (today):** the OpenClaw connector always sends
  `x-openclaw-scopes: operator.read operator.write` in its requests.
  This is correct against `trusted-proxy` mode and harmlessly ignored
  in `token` mode. The code reads as Option B from day one.
- **Local gateway config (today):** stays on `token` mode for now.
  finn-on-VM talks to `127.0.0.1:18789` with the operator Bearer
  token, which is treated as full operator.
- **Threat-equivalence (today):** in this transitional posture, the
  finn process on the same machine has the same effective trust as
  the OpenClaw TUI on the same machine. finn does **not** introduce
  a new privilege escalation path.
- **Migration to Option B:** is a separate piece of work, tracked as
  a follow-up: change gateway `auth.mode` to `trusted-proxy` on each
  reachable gateway, configure trusted-source rules (tailscale or
  loopback as appropriate), verify TUI/webchat still work, then
  finn's already-correct headers begin to enforce the intended
  scoping.

## Scope set finn will request

Initial value:

```
x-openclaw-scopes: operator.read operator.write
```

Justification:

| Scope                  | Why finn needs it (or doesn't)                            |
| ---------------------- | --------------------------------------------------------- |
| `operator.admin`       | **No.** finn never reconfigures the gateway.              |
| `operator.approvals`   | **No.** finn has its own approval flow at the UI layer.   |
| `operator.pairing`     | **No.** finn does not pair devices.                       |
| `operator.read`        | **Yes.** chat-completion implies reading agent state.     |
| `operator.talk.secrets`| **No.** finn does not need the secrets-talking surface.   |
| `operator.write`       | **Yes.** chat-completion is a write to agent state.       |

If a future feature genuinely needs a wider scope, that is a separate
ADR and a deliberate decision, not a config tweak.

## Token storage

The bearer token used in transitional Option-A posture lives in:

```
~/finn-data/secrets/.env
```

with mode `0600`. The repository never reads this path; the running
finn process (dev or prod) reads it via process env. The
`~/finn-data/` volume is not part of the git repo and never will be —
this is enforced both by `.gitignore` patterns and by physical
location (`~/finn-data` is outside `~/Repositories/finn`).

When the migration to Option B completes and the gateway no longer
requires a shared bearer secret on the in-network path, this file
collapses to per-gateway URL-only configuration; the secret is
removed.

## Consequences

- finn is committed to a frontend-only role; we will not add a
  finn-specific OpenClaw agent.
- All OpenClaw connector code paths must thread the
  `x-openclaw-scopes` header. This is enforced by review, not by
  type system.
- Scopes are versioned by ADR. The connector's hardcoded scope
  string must match the ADR; if either changes, both change.
- The gateway-config migration to `trusted-proxy` is now a known
  follow-up, not a "maybe one day."
- finn never gets `operator.admin`. If something inside finn needs
  to reconfigure the gateway, that flow happens out-of-band (you
  go to the OpenClaw TUI), not through the chat-completion path.

## Follow-ups (not part of this ADR)

- ADR-NN: gateway auth-mode migration plan (per-gateway).
- README §Trust model: user-facing summary of this ADR (not a
  duplicate; a pointer + one paragraph of why).
- `connectors/openclaw.ts`: link to this ADR in the file header
  comment.
