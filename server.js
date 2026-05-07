/**
 * Production entrypoint.
 *
 * Wraps the SvelteKit handler from build/handler.js in a plain node http
 * server, so we can attach the finn WebSocket server to the same port.
 *
 * Layout:
 *   build/                ← SvelteKit + adapter-node output
 *     handler.js          ← exported request handler
 *   dist-server/          ← parallel TS build of src/lib/server (see
 *                           tsconfig.server.json), used because the WS
 *                           layer is intentionally outside SvelteKit's
 *                           module graph.
 *
 * Build:
 *   npm run build         ← runs both `vite build` and `tsc -p tsconfig.server.json`
 *
 * Run:
 *   node server.js
 *   (loads ~/finn-data/secrets/.env automatically; PORT/HOST overridable)
 */

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';

// Load secrets BEFORE importing any module that reads process.env at
// module-init time. See docs/decisions/0001 §Token storage.
dotenv.config({
	path: path.join(os.homedir(), 'finn-data', 'secrets', '.env'),
	quiet: true
});

// Order: env first, SvelteKit handler second, finn server modules third.
const { handler } = await import('./build/handler.js');
const { attachWebSocketServer } = await import('./dist-server/ws/attach.js');
const { handleUserMessage } = await import('./dist-server/handle-user-message.js');

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

const server = http.createServer(handler);

attachWebSocketServer(server, {
	onUserMessage: handleUserMessage
});

server.listen(port, host, () => {
	console.log(`finn listening on http://${host}:${port}`);
});
