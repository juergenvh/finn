/**
 * Production entrypoint.
 *
 * Wraps the SvelteKit handler from build/handler.js in a plain node http
 * server, so we can attach the finn WebSocket server to the same port.
 *
 * Run after `npm run build`:
 *   FINN_OPENCLAW_API_KEY=... node server.js
 *
 * TODO: the import paths below for attach/registry are *not yet verified*
 * against an actual adapter-node build output. adapter-node bundles SSR
 * code in `build/server/` but the exact filenames depend on Vite's
 * chunking. We will fix these paths after the first `npm run build` and
 * confirm the production path E2E. The dev path (vite-plugin) is the
 * authoritative spike target for today.
 */

import http from 'node:http';
import { handler } from './build/handler.js';
import { attachWebSocketServer } from './build/server/chunks/attach.js'; // PATH UNVERIFIED
import { dispatchUserMessage } from './build/server/chunks/registry.js'; // PATH UNVERIFIED

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

const server = http.createServer(handler);

attachWebSocketServer(server, {
	onUserMessage: (msg) => dispatchUserMessage(msg)
});

server.listen(port, host, () => {
	console.log(`finn listening on http://${host}:${port}`);
});
