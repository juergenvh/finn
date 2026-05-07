/**
 * Vite dev-plugin: attaches the finn WebSocket server to Vite's HTTP server
 * so that ws://localhost:5173/ws works in `npm run dev`.
 *
 * Mirrors what /server.js does in production.
 */

import type { Plugin, ViteDevServer } from 'vite';
import { attachWebSocketServer } from './attach.ts';
import { handleUserMessage } from '../handle-user-message.ts';
import { handleApprovalDecide } from '../handle-approval-decide.ts';

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
