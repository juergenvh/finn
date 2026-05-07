# ADR 0008 — `globalThis` singleton for the active WebSocket server

- **Status:** accepted
- **Date:** 2026-05-07
- **Deciders:** Jürgen, Dixie
- **Related:** ADR-0007 §"Decision 7", lessons.md (corresponding entry)

## Context

`src/lib/server/ws/attach.ts` exposes `attachWebSocketServer()` (called
once at process start) and `broadcastStateChange()` /
`broadcastEvent()` (called from REST handlers when state changes
that connected clients should learn about live).

The latter two need a reference to the active `WebSocketServer`. The
obvious place to keep it is module-scope:

```ts
let activeWss: WebSocketServer | null = null;
```

That works in production (one `node server.js` process, one shared
SvelteKit handler graph, one `attach.ts` module instance). It fails
in dev.

### What goes wrong in dev

The Vite dev server has multiple module-resolution contexts:

1. **Vite's plugin host.** Loads `src/lib/server/ws/dev-plugin.ts`
   to install the Vite plugin that attaches the WebSocket on
   server start. From this context, `dev-plugin.ts` imports
   `attach.ts` and calls `attachWebSocketServer(...)`.
2. **SvelteKit's SSR module graph.** Loads
   `src/routes/api/.../+server.ts` route handlers. From this
   context, the handlers import the same `attach.ts` and call
   `broadcastStateChange(...)`.

Both imports refer to the same source file. Both get the same code.
**But** Vite caches modules per resolution context, and the two
contexts are separate caches. The module evaluates twice; the
`activeWss` module-scope variable exists twice — once with the live
WebSocketServer (inside the plugin host) and once `null` forever
(inside the SSR graph).

The route handlers see the `null` copy, hit the no-op guard, and
silently fail to broadcast.

This is reproducible and mode-specific: production never hits it
because `server.js` collapses everything into one Node module
graph. The bug surfaces only in `npm run dev`.

## Decision

Park the active server reference on `globalThis`:

```ts
const WSS_KEY = '__finn_active_wss__';
function getActiveWss(): WebSocketServer | null {
    return (globalThis as any)[WSS_KEY] ?? null;
}
function setActiveWss(wss: WebSocketServer | null): void {
    (globalThis as any)[WSS_KEY] = wss;
}
```

`globalThis` is process-wide. Both Vite's plugin host and the
SvelteKit SSR graph share the same Node process, therefore the
same `globalThis`. The reference is set once (when the WS
attaches) and read by anyone who needs it, regardless of which
module instance their `attach.ts` came from.

The fix is documented inline in `attach.ts` so a future maintainer
encountering the global does not assume sloppiness.

## Alternatives considered

### (a) Unify the import paths

In theory, if `dev-plugin.ts` and the route handlers both import
`attach` via the *same* module specifier, Vite's resolution might
collapse them to one cache entry.

Tested: doesn't work. Vite's plugin host loads files via a
separate resolver; the dual-cache problem persists even with
identical specifiers.

### (b) Move the WebSocketServer reference into a Vite-managed
"shared module"

Some build systems offer a "share this between contexts"
mechanism. Vite has nothing equivalent at the level we need
(`server.middlewareMode` configurations get close but bring in
their own SvelteKit-incompatible behaviour).

### (c) Use Vite's `server.ws` (the built-in HMR WebSocket)

We already mounted our own `WebSocketServer` because the protocol
is finn-specific. Reusing Vite's HMR socket would conflate dev
HMR traffic with finn's chat traffic. Not viable.

### (d) Refactor so REST handlers use a hook → emit pattern, like
the WS hooks do

Possible but invasive. The chat hooks have a per-request `Emit`
callback that's threaded from `attach.ts` into `handle-*`
modules. Doing the same for REST routes would mean either:

- Threading a callback through SvelteKit's `RequestHandler`
  signature (impossible without monkey-patching SvelteKit).
- Building a per-request request-context that carries an
  emit-helper, and a way for routes to access it.

That is a larger refactor than the bug warrants. The
`globalThis` fix is six lines.

### (e) Live with the dev-only bug

Rejected. The dev server is where development happens. A
silently-failing broadcast in dev is the worst kind of bug
because the "it works in prod" reflex hides it.

## Decision rationale

`globalThis` is the dimmest tool that solves the problem
correctly. We accept that it puts a single key into the process
global namespace. In return:

- Dev and prod behave identically.
- The fix lives in one file and is self-explanatory with the
  comment.
- No build-system surgery, no SvelteKit version coupling, no
  refactoring of existing hooks.

## Consequences

- The `__finn_active_wss__` key is reserved on `globalThis`.
  Future code in this process must not collide. Documented in
  the comment at the top of the singleton block in `attach.ts`.
- If finn ever runs in a multi-server-instance configuration
  (e.g. multiple Node processes with a shared event bus), this
  fix is per-process. Cross-process broadcast then needs a
  different layer (Redis pub/sub, NATS, etc.). That is far
  beyond MVP and would have its own ADR.
- A future Vite version, or a switch to a different dev server,
  may make module instances singular again. If that happens,
  this ADR becomes mostly historical and the singleton can be
  retired without API impact (the public surface of `attach.ts`
  doesn't change).

## When to revisit

- A Vite update that documents fixed module-instance behaviour.
- A migration off Vite (unlikely; SvelteKit is Vite-coupled).
- The first multi-process finn deployment. (Would replace the
  singleton with an event bus, not roll it back.)

## Footnote: why this is in `attach.ts`, not somewhere "neutral"

A common reflex would be to factor the singleton into a
`src/lib/server/state.ts` or similar. Resisted because:

- Only `attach.ts` reads or writes it.
- Moving it adds a layer without information.
- Inline placement keeps the comment-explaining-the-why next to
  the code-doing-the-thing, which is where it does the most
  work.

If a second piece of state ever needs the same treatment, that
is the right time to introduce the neutral module.
