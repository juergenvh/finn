# src/lib/server/ — finn server-side modules

Code in this directory has **two compilation paths**:

1. **SvelteKit's own server build** (adapter-node) — modules
   imported from a `+page.server.ts`, `+server.ts`, route `load`, or
   `src/hooks.server.ts` are bundled into `build/` by Vite.
2. **Standalone server build** (`tsc -p tsconfig.server.json`) — modules
   under this directory are *also* compiled into `dist-server/`. This
   is the path the production `server.js` consumes for the WebSocket
   layer and connectors, which live next to the SvelteKit handler
   rather than inside the route graph.

Both paths read the same `.ts` source. They produce different output
directories with different module-resolution conventions, but neither
one rewrites the source.

## Convention

- Files use `.ts` extension on imports (e.g. `import x from './y.ts'`).
  The `tsconfig` settings (`rewriteRelativeImportExtensions`) translate
  these to `.js` in the emitted output.
- Anything that needs to run *outside* the SvelteKit handler
  (WebSocket lifecycle, scheduled jobs, etc.) goes here and is reached
  through `dist-server/`.
- Anything that needs to run *inside* a request (auth checks, database
  reads from a route) can also go here, but is reached through Vite's
  resolution (`$lib/server/...`).

## Adding a new module

If you add a new `.ts` file under `src/lib/server/`, it is automatically
picked up by both build paths. No registration step needed.

## Why two builds?

Because SvelteKit's build only includes modules reachable from a route
or hook. The WebSocket attach helper lives next to `server.js`, not
inside a route, so it is not in that graph. The simplest way to stay
honest about that is to compile it separately rather than smuggle it
into the SvelteKit graph through a synthetic import.
