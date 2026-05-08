# ADR 0012 — Agent-aware session-key format

- **Status:** accepted
- **Date:** 2026-05-08
- **Deciders:** Jürgen, Dixie
- **Supersedes:** ADR-0002 §"Decision" (the bare `finn:<channel_id>`
  format on its own is no longer sufficient for multi-agent setups;
  the rationale and options-considered in ADR-0002 remain the
  authoritative record for *why* there is a session-key at all)
- **Related:** ADR-0001 (auth), ADR-0002 (original session-key
  rationale), `docs/connectors.md` §"Caveat: agent selection vs.
  session continuity", issue #23.

## Context

ADR-0002 picked `x-openclaw-session-key: finn:<channel_id>` to give
each finn channel a stable OpenClaw-side agent session. At the time
finn only had one OpenClaw agent target on the other side — the
seeded `dixie` — so encoding the agent into the session-key was not
necessary.

When we tried to wire a second OpenClaw agent (`gwen`, local-Ollama
persona) into finn on 2026-05-08, the multi-agent path did not work
on existing channels. Replying with `model: openclaw/gwen` from
finn's UI produced replies from Dixie. We chased several wrong
hypotheses before reaching ground truth via console.log on the
connector and `curl` against the gateway. The actual root cause is
in OpenClaw's session-key store contract.

### What the gateway does

The OpenAI-compatible HTTP endpoint
([upstream docs](https://docs.openclaw.ai/gateway/openai-http-api))
treats the `model` field as an agent target — `openclaw`,
`openclaw/default`, or `openclaw/<agentId>`. **On a fresh
session-key**, the agent suffix is honored:

```bash
# No session-key, model=openclaw/gwen
curl … -d '{"model":"openclaw/gwen", …}'
# → reply from Gwen, prompt_tokens: 12765
```

But OpenClaw rewrites the explicit `x-openclaw-session-key` header
through `toAgentStoreSessionKey()` upstream, which scopes the key by
the *resolved* agent. The resolved agent for that scoping comes from
the request — `x-openclaw-agent-id` first, then the `model` field —
**but the wrap happens at session-store time**, after which an
existing session under `agent:<otherAgent>:<our-key>` can take
precedence.

In practice this means: for any session-key that does *not* already
start with `agent:<id>:`, the gateway re-wraps it as
`agent:<resolved-agent>:<key>`. If a finn channel previously talked
to Dixie under `finn:c_X`, the gateway's session store has
`agent:dixie:finn:c_X`. When finn later sends the same `finn:c_X`
key targeting Gwen, the gateway sees an existing session under
`agent:dixie:finn:c_X` and the call lands there.

The fix is to send a session-key that the gateway already
recognises as agent-scoped: a key starting with `agent:<id>:`.

### What we verified

```bash
# session-key without agent: prefix, gateway re-resolves agent
curl -H 'x-openclaw-session-key: finn:c_X' \
     -d '{"model":"openclaw/gwen", …}'
# → Dixie (existing dixie-bound session under same channel)

# explicit agent: prefix, gateway uses that scope directly
curl -H 'x-openclaw-session-key: agent:gwen:finn:c_X' \
     -d '{"model":"openclaw/gwen", …}'
# → Gwen, prompt_tokens: 12785

# back to default agent on same channel = different store key
curl -H 'x-openclaw-session-key: finn:c_X' \
     -d '{"model":"openclaw", …}'
# → Dixie continuity (different store entry from gwen's)
```

## Decision

**Send agent-scoped session-keys for explicit-agent calls and
ADR-0002's original shape for default-agent calls.** Two shapes,
chosen by the connector based on the agent's `model` field:

| Connector `model` field | Session-key sent                            |
| ----------------------- | ------------------------------------------- |
| `openclaw`              | `finn:<channel_id>` (ADR-0002 original)     |
| `openclaw/default`      | `finn:<channel_id>`                         |
| `openclaw/<agentId>`    | `agent:<agentId>:finn:<channel_id>`         |

### Why two shapes, not one

We considered always sending `agent:<resolved-agent-id>:finn:<channel_id>`,
including for the default case. That would require finn to know the
gateway's currently-configured default-agent id (e.g. `dixie`). It
does not, by design — finn's `model: openclaw` is intentionally
opaque to "who the default is". Two reasons to keep it that way:

1. **Continuity across rename.** If the gateway operator later
   renames the default agent (e.g. to `dixie-v2`) or swaps which
   agent has the `default` flag, finn channels keep working without
   a finn-side migration. The gateway re-resolves the default at
   session-store time.
2. **Single source of truth.** The gateway is the authority on
   "which agent answers when no agent is specified". Encoding that
   answer into the finn-side session-key would split the truth
   between the gateway config and finn's session-key derivation.

For the explicit-agent case we lose nothing: the agent id is
already pinned by the connector's `model: openclaw/<agentId>`, so
including it in the session-key just makes that pinning visible to
the gateway's session-key parser.

## Migration

The old session-keys (`finn:<channel_id>` everywhere, no agent
component) are still produced unchanged for default-agent calls, so
**channels that have only ever talked to the default agent keep
their continuity** across this change. No data migration needed for
that path.

For channels that were retargeted to a non-default agent during
2026-05-08 debugging (so they have a `agent:dixie:finn:c_X` session
on the gateway from the wrong-routing turns), the gateway-side
sessions are *orphaned* by this change: future calls to the same
channel under `model: openclaw/gwen` open a fresh
`agent:gwen:finn:c_X` session and Gwen's history starts empty. We
are single-user pre-public; the orphaned bytes are debug noise from
this morning. No bridging script needed.

## Consequences

**Positive.**

- Multi-agent routing in finn actually works. A finn channel can
  switch the active agent by editing the agent's `model` field —
  next turn opens a session under the correct agent.
- The `salon` channel pattern (one channel, several agents) becomes
  buildable. Each agent in the channel maintains its own per-channel
  session, no hijacking.
- Default-agent continuity is preserved across this change: existing
  channels that were always talking to Dixie keep their session.

**Negative.**

- The connector now emits two session-key shapes instead of one.
  The asymmetry maps to a real semantic difference (default vs.
  explicit) and is documented in the file-level docblock and
  this ADR; we judged that clearer than always sending the
  `agent:` prefix and pinning to a specific id finn-side.
- ADR-0002's "stay in sync" warning on the session-key prefix now
  has two ADRs governing it. We mark this ADR as superseding
  ADR-0002 §"Decision" and leave 0002's context/options-considered
  intact for the historical record.

**Followups (not blocking).**

- Issue #22 (connector backend-model override via `x-openclaw-model`)
  remains a separate concern; this ADR does not touch it.
- Issue #23 closes with this ADR + the implementing PR.
- `docs/connectors.md` §"Caveat" should be revised in a small
  follow-up doc PR to point at this ADR and remove the "until it
  lands" framing.

## Touched files

- `src/lib/server/connectors/openclaw.ts` — `explicitAgentIdFromModel()`
  helper, `sessionKeyFor()` extended, file-level docblock updated.
- `docs/decisions/0012-agent-aware-session-key.md` — this file.
- `docs/decisions/0002-session-key-format.md` — superseded note added.
- `docs/README.md` — ADR list entry.
