# ADR 0024 — Drop the test-era connector system prompt

- **Status:** accepted (shipped via this PR, 2026-05-15)
- **Date:** 2026-05-15
- **Deciders:** Jürgen, Dixie
- **Related:** ADR-0001 (OpenClaw connector trust model — finn
  is a router, not a persona), ADR-0017 (agent-bound session
  override — agent identity lives on the agent side, not the
  router side), connector files
  `src/lib/server/connectors/openclaw.ts` and
  `src/lib/server/connectors/openai-compatible.ts`.

## Context

Both the `openclaw` and `openai-compatible` connectors prepended
a hardcoded `system` message to every upstream
`POST /chat/completions` request:

```
You are an assistant being addressed through 'finn', a multi-agent
chat router. Reply concisely; the user is testing channel plumbing.
```

This string was an early scaffold from the connector bring-up
phase, when finn was being smoke-tested against fresh
backends and a steering hint was useful to keep replies short
while the plumbing was being validated. It was never intended
to be the steady-state contract between finn and its agents.

Two reasons to remove it now:

1. **It is factually stale.** "The user is testing channel
   plumbing" was true on day one. It is not true today. Agents
   that take the system prompt seriously (Dixie, Wintermute,
   any other persona-driven agent) get told every turn that
   they are a test fixture, which is both misleading and
   undermines the agent's own SOUL/persona configuration.

2. **It violates the connector trust model from ADR-0001.**
   finn is a router. The agent on the other side owns its own
   identity and behaviour configuration (system prompt,
   persona, tools, memory). Injecting a finn-side system
   message conflates the two layers: finn is not an authority
   on how the agent should reply, and pretending otherwise
   produces exactly the surprise Jürgen noticed in the
   2026-05-15 webchat session (the "Group Chat Context" block
   appeared in Dixie's runtime context with stale wording).

The `anthropic-stub` connector already shipped without a
system prompt — it is internally inconsistent that the two
real connectors did not.

## Decision

Remove the hardcoded `SYSTEM_PROMPT` constant and the
corresponding leading `{ role: 'system' }` message from both
the `openclaw` and `openai-compatible` connectors. The
outbound `messages` array now contains only the
`{ role: 'user', content: <body> }` turn that the channel
produced.

Behavioural consequence: upstream agents receive only the
user message; their own system-prompt configuration (whatever
the upstream agent runtime injects — Dixie's
`AGENTS.md`/`SOUL.md` bootstrap for OpenClaw, Wintermute's
adapter-side prompt for the OpenAI-compatible path) is the
sole authority on persona and reply style.

## Consequences

### Positive

- **Honest layering.** finn stops claiming to be an authority
  on agent persona; the agent runtime owns its identity end
  to end.
- **No more stale-test-string leakage.** Future readers of an
  agent's runtime context never again see the "testing
  channel plumbing" wording.
- **Connector consistency.** All three connectors
  (`openclaw`, `openai-compatible`, `anthropic-stub`) now have
  the same shape: pass through the user turn, do not inject
  finn-side system messages.

### Negative

- **Backends that previously benefited from the "reply
  concisely" hint may now produce longer replies.** Mitigation:
  if any concrete backend regresses, the correct fix is on the
  agent side (its own system prompt), not on the router side.
  No such regression is known at the time of writing.

### Out of scope

- **Per-agent configurable router-side system context.** A
  future feature might let an operator attach finn-side
  context to a given agent (e.g. "this agent is being used
  in a customer-support channel"). That is a real feature
  with a real settings/DB shape and would get its own ADR;
  it is explicitly **not** what this ADR is doing. Today's
  diff is "remove the test-era scaffold," not "build the
  configurable replacement."

## Implementation

Two files touched, ~2 lines added, ~16 lines removed:

- `src/lib/server/connectors/openclaw.ts`
- `src/lib/server/connectors/openai-compatible.ts`

`npm run check` (svelte-check, 0 errors / 0 warnings) and
`npm test` (30/30 vitest tests) both pass on the resulting
branch.

## Notes for future readers

If you see finn appearing to add a system message to upstream
requests after this ADR ships, that is a regression — either
in a future connector or in middleware. The intended steady
state is "finn forwards the user turn, period."
