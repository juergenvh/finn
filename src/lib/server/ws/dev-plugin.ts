/**
 * Vite dev-plugin: attaches the finn WebSocket server to Vite's HTTP server
 * so that ws://localhost:5173/ws works in `npm run dev`.
 *
 * Mirrors what /server.js does in production.
 */

import type { Plugin, ViteDevServer } from 'vite';

// IMPORTANT: these imports use the same module specifiers that the
// SvelteKit route handlers use (relative paths without explicit .ts
// extensions, plus the $lib alias). Vite resolves them and routes to
// the *same* module instance both ways, which matters because
// attach.ts holds the active WebSocketServer in module scope so that
// REST endpoints can broadcast events through it. Mismatched
// specifiers would create two separate module copies and the
// REST-side broadcasts would silently no-op.
//
// dist-server (the prod build of src/lib/server/**) is unaffected:
// dev-plugin.ts is loaded by Vite's plugin host, never by the
// production server.js, and tsc rewrites .ts → .js according to
// tsconfig.server.json's rewriteRelativeImportExtensions for the
// modules that DO end up in dist-server.
import { attachWebSocketServer } from './attach';
import { handleUserMessage } from '../handle-user-message';
import { handleApprovalDecide } from '../handle-approval-decide';

export function finnWsDevPlugin(): Plugin {
	return {
		name: 'finn:ws-dev-plugin',
		configureServer(server: ViteDevServer) {
			if (!server.httpServer) return;
			attachWebSocketServer(server.httpServer, {
				onUserMessage: handleUserMessage,
				onApprovalDecide: handleApprovalDecide
			});
		}
	};
}
