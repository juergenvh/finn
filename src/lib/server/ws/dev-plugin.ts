/**
 * Vite dev-plugin: attaches the finn WebSocket server to Vite's HTTP server
 * so that ws://localhost:5173/ws works in `npm run dev`.
 *
 * Mirrors what /server.js does in production (see Step 4 of the
 * SvelteKit-WebSocket pattern).
 */

import type { Plugin, ViteDevServer } from 'vite';
import { attachWebSocketServer } from './attach';
import { dispatchUserMessage } from '../connectors/registry';

export function finnWsDevPlugin(): Plugin {
	return {
		name: 'finn:ws-dev-plugin',
		configureServer(server: ViteDevServer) {
			if (!server.httpServer) {
				// Vite is running in middleware-only mode; nothing to attach to.
				return;
			}
			attachWebSocketServer(server.httpServer, {
				onUserMessage: (msg) => dispatchUserMessage(msg)
			});
		}
	};
}
