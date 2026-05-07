/**
 * Attach a WebSocket server to a given HTTP server.
 *
 * Path: ws://<host>/ws
 *
 * Used in two places:
 *   - Vite dev server (via dev-plugin.ts)
 *   - Production node server (via /server.js, after adapter-node build)
 *
 * The attach() function is intentionally framework-agnostic: it takes any
 * `http.Server`-compatible object and wires up a WebSocketServer in
 * `noServer` mode, then routes the HTTP `upgrade` event by path.
 *
 * It is also intentionally DB-agnostic. Persistence and dispatch happen
 * in the hooks supplied by the caller (see `FinnHooks`). attach.ts only
 * knows about the wire protocol.
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const WS_PATH = '/ws';

export type FinnInbound =
	| { type: 'user_message'; channel_id: string; body: string }
	| { type: 'ping' };

export type FinnOutbound =
	| {
			type: 'message';
			channel_id: string;
			sender: 'user' | 'agent' | 'system';
			body: string;
			ts: number;
			id?: string;
	  }
	| { type: 'system'; body: string }
	| { type: 'pong' };

export interface FinnHooks {
	/**
	 * Called when a client sends a user message. The hook is responsible
	 * for persisting the user turn, calling the appropriate connector,
	 * persisting the agent reply, and returning the broadcast payloads.
	 *
	 * Returning `null`/`undefined` means "no reply" (e.g. echo-mode
	 * disabled and no connector configured); the user message is still
	 * broadcast.
	 */
	onUserMessage?: (msg: { channel_id: string; body: string }) =>
		| Promise<UserMessageResult | null | undefined>
		| UserMessageResult
		| null
		| undefined;
}

export type UserMessageResult = {
	/** What to broadcast for the user's own turn. Already persisted. */
	user: FinnOutbound & { type: 'message'; sender: 'user' };
	/** Reply broadcast, if any. Already persisted. */
	agent?: FinnOutbound & { type: 'message'; sender: 'agent' };
};

/**
 * Minimal HTTP-server surface we actually use. Both node:http.Server and
 * Vite's exposed httpServer (which may be http or http2) implement these,
 * so we widen our type to the structural intersection rather than depend
 * on a specific concrete type.
 */
export interface UpgradableHttpServer {
	on(event: 'upgrade', listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
}

let attached: WebSocketServer | null = null;

export function attachWebSocketServer(httpServer: UpgradableHttpServer, hooks: FinnHooks = {}): WebSocketServer {
	if (attached) {
		// Vite HMR can re-import this file. Re-attaching would leak handlers.
		return attached;
	}

	const wss = new WebSocketServer({ noServer: true });

	httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
		const url = new URL(req.url ?? '/', 'http://localhost');
		if (url.pathname !== WS_PATH) {
			// Not ours. Let other listeners (Vite HMR) handle it.
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => {
			wss.emit('connection', ws, req);
		});
	});

	wss.on('connection', (ws: WebSocket) => {
		send(ws, { type: 'system', body: 'connected to finn' });

		ws.on('message', async (raw) => {
			let parsed: FinnInbound;
			try {
				parsed = JSON.parse(raw.toString());
			} catch {
				send(ws, { type: 'system', body: 'invalid json' });
				return;
			}

			if (parsed.type === 'ping') {
				send(ws, { type: 'pong' });
				return;
			}

			if (parsed.type === 'user_message') {
				if (!hooks.onUserMessage) {
					send(ws, { type: 'system', body: 'no message handler configured' });
					return;
				}
				try {
					const result = await hooks.onUserMessage({
						channel_id: parsed.channel_id,
						body: parsed.body
					});
					if (!result) return;
					broadcast(wss, result.user);
					if (result.agent) broadcast(wss, result.agent);
				} catch (err) {
					broadcast(wss, {
						type: 'system',
						body: `error: ${(err as Error).message}`
					});
				}
			}
		});
	});

	attached = wss;
	return wss;
}

function send(ws: WebSocket, msg: FinnOutbound): void {
	if (ws.readyState === ws.OPEN) {
		ws.send(JSON.stringify(msg));
	}
}

function broadcast(wss: WebSocketServer, msg: FinnOutbound): void {
	const payload = JSON.stringify(msg);
	for (const client of wss.clients) {
		if (client.readyState === client.OPEN) {
			client.send(payload);
		}
	}
}
