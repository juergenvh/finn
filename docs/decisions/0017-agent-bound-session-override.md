# ADR 0017 — Agent-bound session override

- **Status:** proposed
- **Date:** 2026-05-10
- **Deciders:** Jürgen, Dixie
- **Related:** ADR-0002 (original session-key rationale),
  ADR-0012 (agent-aware session-key format),
  ADR-0018 (agent-name in bubble header),
  `src/lib/server/connectors/openclaw.ts`,
  `src/lib/server/db/agent-config.ts`.

## Context

ADR-0012 established that the session-key sent to OpenClaw is
**channel-bound, agent-scoped**: `agent:<agentId>:finn:<channel_id>`
for explicit-agent calls, `finn:<channel_id>` for default. This is
correct for the common case — one OpenClaw agent per finn channel,
each channel its own conversation thread.

The case it does *not* cover is what the upstream OpenClaw side
calls "session keys": the user wants the same OpenClaw agent to
maintain **separate, named conversations** that aren't pinned to a
finn channel. Concretely (from the design conversation 2026-05-10):

> "I'd like to address Dixie inside finn from a session called
> `finn`, while my OpenClaw TUI talks to the same Dixie under the
> default `main` session. Different memory windows, same persona,
> no pollution."

OpenClaw makes this possible per-call (`x-openclaw-session-key:
agent:dixie:finn` instead of `agent:dixie:finn:c_X`). What's missing
is a finn-side way to express the choice.

### Where the override should live

We considered three layers and discarded two:

| Layer       | Verdict     | Reasoning                                    |
| ----------- | ----------- | -------------------------------------------- |
| **Channel** | rejected    | Routing-edge explosion. Forwarding gets a new dimension ("forward into which session?"). UI gets a new mandatory dialog or hidden default. The `@-mention` token loses its 1:1 meaning. |
| **Agent**   | **chosen**  | Session is a property of "who you are talking to", not "which room you are in". Two sessions = two conversation partners with shared persona but disjoint memory. Modelling them as two agent-registry rows matches the mental model. |
| **Per-message** | rejected (now) | Could be revisited when forwarding-to-agents-outside-channel lands (separate ADR). For day-to-day routing, requiring per-message choice is friction, not power. |

The agent-level decision **erases** the routing question. A finn
channel has a member list; members are agents; each agent knows its
own session. No per-channel override, no per-message override, no
disambiguation dialog at `@-mention` or forward time.

### Trade-off, made explicit

Users who want N sessions on one upstream agent register N agent
rows pointing at the same upstream:

```
dixie         (config: model="openclaw",          → agent:dixie:finn:c_X         on each channel)
dixie-finn    (config: model="openclaw/dixie",    session_override="finn"     → agent:dixie:finn               flat)
dixie-saged   (config: model="openclaw/dixie",    session_override="sagesmith"→ agent:dixie:sagesmith          flat)
```

This is N×session rows in the agent table, not 1×agent + N
overrides elsewhere. Two reasons we accept that:

1. **Honest mental model.** Different sessions = different
   conversation partners. Different agent rows make that visible.
2. **Existing primitives suffice.** The agent registry already
   handles enable/disable, naming, channel-membership. Reusing it
   for session-variants costs no new schema beyond one optional
   field.

### What about the current channel-bound shape?

ADR-0012's `agent:<agentId>:finn:<channel_id>` shape stays the
default. The override is **opt-in**: when an agent sets
`session_override`, the connector emits a *flat* session-key shape
that drops the channel component:

| `session_override` | Session-key sent                            |
| ------------------ | ------------------------------------------- |
| (absent)           | `agent:<agentId>:finn:<channel_id>` (ADR-0012) |
| `"finn"`           | `agent:<agentId>:finn`                      |
| `"sagesmith"`      | `agent:<agentId>:sagesmith`                 |
| `"main"`           | `agent:<agentId>:main`                      |

The channel component drops out because the *whole point* of an
override is "this agent maintains one conversation regardless of
which finn channel I'm using it in". If the user wanted per-channel
isolation they'd use the default (no override), exactly as today.

The `agent:<agentId>:` prefix is preserved so ADR-0012's parser
recognition still works upstream.

### Why not embed the channel id inside the override too?

We considered `agent:<agentId>:<override>:finn:<channel_id>` for
override+channel scoping. Rejected: it re-introduces the
explosion ADR-0012's two-shape decision was meant to contain. If
the user wants per-channel scoping they can omit the override; if
they want a flat named conversation they set the override. Mixing
both would mean four shapes (default-flat, default-channel,
override-flat, override-channel) and require explaining when each
applies. Two shapes is enough.

## Decision

**Add an optional `session_override` field to the OpenClaw
connector config.** When present, the connector emits
`agent:<agentId>:<session_override>` as the session-key, dropping
the channel-id component. When absent, ADR-0012's shapes apply
unchanged.

### Schema change

`src/lib/server/db/agent-config.ts`,
`OpenclawConfigSchema`:

```ts
export const OpenclawConfigSchema = z.object({
  connector_type: z.literal('openclaw'),
  base_url: z.string().url(),
  token_env_var: z.string().min(1).default('FINN_OPENCLAW_API_KEY'),
  model: z.string().min(1).default('openclaw'),
  /** Optional. When set, the connector pins this agent to the named
   * upstream session (e.g. "finn", "sagesmith") regardless of which
   * finn channel it's used in. Drops the channel-id component from
   * the session-key. Use when you want the same upstream agent to
   * maintain one conversation across channels, OR to share an
   * upstream session with a non-finn client (TUI, webchat). */
  session_override: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i, 'session_override must be a session-key-safe identifier')
    .optional()
});
```

The validation regex matches the upstream OpenClaw session-key
character set we already rely on in `explicitAgentIdFromModel()`.

### Connector change

`src/lib/server/connectors/openclaw.ts`, `sessionKeyFor()`:

```ts
function sessionKeyFor(
  explicitAgentId: string | null,
  channelId: string,
  sessionOverride?: string
): string {
  if (sessionOverride) {
    // Override requires an explicit agent id (default-agent + override
    // would need finn to know the gateway's default-agent name; we
    // intentionally do not — see ADR-0012 §"Why two shapes, not one".)
    if (!explicitAgentId) {
      throw new Error(
        'session_override requires an explicit agent in `model` (e.g. "openclaw/dixie"); ' +
          'using "openclaw" / "openclaw/default" with an override is not supported. ' +
          'See ADR-0017.'
      );
    }
    return `agent:${explicitAgentId}:${sessionOverride}`;
  }
  if (explicitAgentId) {
    return `agent:${explicitAgentId}:${FINN_SESSION_PREFIX}:${channelId}`;
  }
  return `${FINN_SESSION_PREFIX}:${channelId}`;
}
```

The default-agent + override combination is rejected at connector
call time with a clear error. This is consistent with ADR-0012's
"finn is intentionally opaque to who the default is" stance: an
override means the user is being explicit about *which* upstream
session, which only makes sense when they are also explicit about
*which* upstream agent.

### UI change (CRUD form)

The agent-edit form gains an optional **"Session override"** field
in the OpenClaw connector section, with help text:

> Optional. Pins this agent to a named upstream session (e.g. `finn`,
> `sagesmith`), shared across all finn channels using this agent and
> compatible with a non-finn OpenClaw client using the same session
> name. Leave empty for the default per-channel session. Requires
> a specific agent in the **Model** field (e.g. `openclaw/dixie`),
> not the bare `openclaw` default.

The form shows a validation error inline when `session_override` is
set but `model` is `openclaw` or `openclaw/default`.

## Migration

No automatic migration. Existing agents have no `session_override`
field; their session-keys keep ADR-0012's shape. Adding the field
to an existing agent will switch *new* turns to the override shape;
turns prior to the change remain in the channel-scoped session on
the gateway. We are single-user pre-public; no migration tooling
needed.

To explicitly migrate an existing agent's history into a named
session, the user can use the OpenClaw CLI's session-export /
session-import path manually. Out of scope for this ADR.

## Consequences

**Positive.**

- Users can run multiple session-variants of the same upstream
  agent (e.g. `dixie`, `dixie-finn`, `dixie-sagesmith`) by
  registering distinct agent rows. The mental model matches the
  reality: different sessions = different conversation partners.
- Sessions can be shared across finn and non-finn clients (TUI,
  webchat) by using the same override name on both sides.
- ADR-0012's default behaviour is preserved bit-for-bit when the
  field is absent. No regressions for the common case.
- Routing stays simple: channel members remain agents; `@-mention`
  is unchanged; forwarding goes to a member, no second routing
  axis introduced.

**Negative.**

- N session-variants for one upstream agent = N agent-registry
  rows. A user with three sessions on Dixie sees three Dixies in
  the agent list. We treat this as honest, not duplication —
  distinct rows for distinct conversation partners. ADR-0018
  (separate) sharpens the bubble-header presentation so the user
  always sees *which* Dixie is replying.
- The connector now has three session-key shapes instead of two
  (channel-default, channel-explicit, override). The third shape
  is opt-in and documented; the discriminator is a single boolean
  ("is `session_override` set?"). Acceptable.
- Default-agent + override is unsupported, validated at connector
  call time. The upgrade path is "name the agent explicitly in
  the model field". Documented in the field's help text and the
  thrown error.

**Followups (not blocking, separate ADRs).**

- **Forwarding to an agent that is not a channel member.** Raised
  in the design conversation as a related-but-separate concern.
  Touches channel membership, not session routing. Open issue,
  no ADR yet.
- **Per-message session choice.** Considered and dropped from
  scope. If a future feature needs it (e.g. ephemeral side-chats),
  it would extend, not replace, this ADR.
- **Capability probe across sessions.** An agent's role labels
  (ADR-0015) come from a capability probe; whether the probe
  honours `session_override` or always uses a clean session is a
  small open question. Default proposal: probe with the override
  applied so the labels match the live behaviour.

## Touched files (when implemented)

- `src/lib/server/db/agent-config.ts` — `OpenclawConfigSchema`
  gains `session_override` (optional).
- `src/lib/server/connectors/openclaw.ts` — `sessionKeyFor()`
  takes a third arg; default-agent+override rejected at call time;
  file-level docblock updated.
- `src/lib/components/AgentForm.svelte` (or equivalent) — new
  optional field with inline validation.
- `docs/connectors.md` — new subsection under OpenClaw connector.
- `docs/decisions/0017-agent-bound-session-override.md` — this file.
- `docs/README.md` — ADR list entry.
- Tests: `tests/unit/openclaw-session-key.test.ts` (or equivalent)
  — three-shape coverage incl. the rejection case.
