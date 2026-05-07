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
 *
 * Wire protocol:
 *   inbound  user_message     { channel_id, body }
 *   inbound  approval_decide  { approval_id, decision, targets?, reject_reason? }
 *   inbound  ping             {}
 *   outbound message          { channel_id, sender, sender_id, body, ts, id }
 *   outbound approval_created { approval, message_id }
 *   outbound approval_updated { approval }
 *   outbound system           { body }
 *   outbound pong             {}
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const WS_PATH = '/ws';

/* ---- inbound ---- */

export type FinnInbound =
	| { type: 'user_message'; channel_id: string; body: string }
	| {
			type: 'approval_decide';
			approval_id: string;
			decision: 'approve' | 'reject';
			targets?: string[];
			reject_reason?: string;
	  }
	| { type: 'ping' };

/* ---- outbound (broadcasts) ---- */

export type ApprovalSnapshot = {
	id: string;
	messageId: string;
	status: 'pending' | 'approved' | 'rejected' | 'routed';
	targets: string[];
	rejectReason: string | null;
	createdAt: number;
	decidedAt: number | null;
};

export type BroadcastMessage = {
	type: 'message';
	channel_id: string;
	sender: 'user' | 'agent' | 'system';
	sender_id: string | null;
	body: string;
	ts: number;
	id: string;
};

export type BroadcastApprovalCreated = {
	type: 'approval_created';
	approval: ApprovalSnapshot;
	message_id: string;
};

export type BroadcastApprovalUpdated = {
	type: 'approval_updated';
	approval: ApprovalSnapshot;
};

export type BroadcastSystem = {
	type: 'system';
	body: string;
};

export type FinnOutbound =
	| BroadcastMessage
	| BroadcastApprovalCreated
	| BroadcastApprovalUpdated
	| BroadcastSystem
	| { type: 'pong' };

/* ---- hooks ---- */

export type UserMessageResult = {
	/** All broadcasts to fan out to clients, in order. */
	broadcasts: Array<BroadcastMessage | BroadcastApprovalCreated | BroadcastApprovalUpdated | BroadcastSystem>;
};

export interface FinnHooks {
	onUserMessage?: (msg: { channel_id: string; body: string }) =>
		| Promise<UserMessageResult>
		| UserMessageResult;
	onApprovalDecide?: (msg: {
		approval_id: string;
		decision: 'approve' | 'reject';
		targets?: string[];
		reject_reason?: string;
	}) => Promise<UserMessageResult> | UserMessageResult;
}

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
		if (url.pathname !== WS_PATH) return;
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
					send(ws, { type: 'system', body: 'no user-message handler configured' });
					return;
				}
				try {
					const result = await hooks.onUserMessage({
						channel_id: parsed.channel_id,
						body: parsed.body
					});
					for (const b of result.broadcasts) broadcast(wss, b);
				} catch (err) {
					broadcast(wss, { type: 'system', body: `error: ${(err as Error).message}` });
				}
				return;
			}

			if (parsed.type === 'approval_decide') {
				if (!hooks.onApprovalDecide) {
					send(ws, { type: 'system', body: 'no approval-decide handler configured' });
					return;
				}
				try {
					const result = await hooks.onApprovalDecide({
						approval_id: parsed.approval_id,
						decision: parsed.decision,
						targets: parsed.targets,
						reject_reason: parsed.reject_reason
					});
					for (const b of result.broadcasts) broadcast(wss, b);
				} catch (err) {
					broadcast(wss, {
						type: 'system',
						body: `approval error: ${(err as Error).message}`
					});
				}
				return;
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
