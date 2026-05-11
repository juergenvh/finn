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
 *   inbound  forward_message  { message_id, target_agent_ids[] }
 *   inbound  ping             {}
 *   outbound message          { channel_id, sender, sender_id, body, ts, id }
 *   outbound message_start    { id, channel_id, sender_id, ts }
 *   outbound message_delta    { id, delta }
 *   outbound message_end      { id, body }
 *   outbound message_error    { id, error }
 *   outbound approval_created { approval, message_id }
 *   outbound approval_updated { approval }
 *   outbound system           { body }
 *   outbound pong             {}
 *
 *   The four message_* events form one streaming-message lifecycle
 *   per agent reply (ADR-0013). User and system messages keep the
 *   single-event `message` form. During phase 2a of the streaming
 *   rollout, agent replies are emitted with both shapes (the four
 *   lifecycle events AND a final `message` event on completion) so
 *   clients that only know the old shape stay functional. Phase 2b
 *   drops the legacy compatibility emit.
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const WS_PATH = '/ws';

/* ---- process-wide state for outbound broadcasts ---- */

/**
 * Reference to the active server, kept so that REST handlers can push
 * state-changed events to all connected clients without going through
 * a per-request hook. Set by attachWebSocketServer; cleared on close.
 *
 * Stored on globalThis because Vite's plugin host and the SvelteKit
 * SSR module graph load this file as separate module instances in
 * dev (different specifiers, different graphs). Module-scope state
 * therefore appears twice and the route-side handlers would never
 * see the WebSocketServer the dev plugin attached.
 *
 * The globalThis singleton is process-wide — always one. In the
 * production server.js path, the SvelteKit handler and the WS
 * attach run in one shared module graph anyway; the global is just
 * never observed to differ from a module-local. Net cost: a key on
 * globalThis. Net benefit: dev and prod agree.
 */
const WSS_KEY = '__finn_active_wss__';
function getActiveWss(): WebSocketServer | null {
	return (globalThis as Record<string, unknown>)[WSS_KEY] as WebSocketServer | null ?? null;
}
function setActiveWss(wss: WebSocketServer | null): void {
	(globalThis as Record<string, unknown>)[WSS_KEY] = wss;
}

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
	| {
			type: 'forward_message';
			message_id: string;
			target_agent_ids: string[];
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

/* --- streaming agent-message lifecycle (ADR-0013) ---
 *
 * Each agent reply produced by the streaming dispatcher emits a
 * `message_start`, zero or more `message_delta` events, and exactly
 * one of `message_end` (clean) or `message_error` (mid-stream
 * failure). All four share the same `id`, which is the final
 * messages-table primary key the row is (or would have been) written
 * with on completion.
 */

export type BroadcastMessageStart = {
	type: 'message_start';
	/** Final message id; matches the eventual DB row on clean end. */
	id: string;
	channel_id: string;
	/** Agent id; streaming starts only exist for agent messages. */
	sender_id: string;
	/** Bubble-rendering timestamp; persisted as `created_at` on end. */
	ts: number;
};

export type BroadcastMessageDelta = {
	type: 'message_delta';
	/** Matches the corresponding `message_start.id`. */
	id: string;
	/** Append to the bubble's body verbatim; UTF-8, no further parsing. */
	delta: string;
};

export type BroadcastMessageEnd = {
	type: 'message_end';
	/** Matches the corresponding `message_start.id`. */
	id: string;
	/** Full final body, in case the client wants to reconcile its buffer. */
	body: string;
	/**
	 * Token-usage counters, when the upstream backend reported them
	 * on its SSE wire (issue #43 part B). Absent for backends that
	 * do not surface usage today (Wintermute's `/v1/*` adapter,
	 * `anthropic-stub`); the client treats absent and null as
	 * equivalent and renders no token footer.
	 */
	tokens?: { input: number; output: number; total: number };
};

export type BroadcastMessageError = {
	type: 'message_error';
	/** Matches the corresponding `message_start.id`. */
	id: string;
	/** Human-readable error; not a stable contract. */
	error: string;
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

export type BroadcastStateChanged = {
	type: 'state_changed';
	entity: 'channel' | 'agent' | 'channel_member' | 'message' | 'settings';
	action: 'created' | 'updated' | 'deleted';
	/** primary key of the affected row. For channel_member, this is
	 * the channel id; the affected agent is in `extra.agent_id`. For
	 * message updates (e.g. visibility / grooming), the channel id
	 * is in `extra.channel_id` so subscribers can scope updates.
	 *
	 * For `settings` (ADR-0019), `id` is either the literal string
	 * `"global"` (when the global row changed) or the channel id
	 * whose per-channel override row was created/updated/deleted.
	 * Subscribers compare `id` directly; no `extra.scope` needed. */
	id: string;
	extra?: Record<string, string | number | boolean | null>;
};

export type FinnOutbound =
	| BroadcastMessage
	| BroadcastMessageStart
	| BroadcastMessageDelta
	| BroadcastMessageEnd
	| BroadcastMessageError
	| BroadcastApprovalCreated
	| BroadcastApprovalUpdated
	| BroadcastStateChanged
	| BroadcastSystem
	| { type: 'pong' };

/* ---- hooks ---- */

/**
 * The hook receives an `emit` callback and is expected to call it for
 * every broadcast as soon as that broadcast is ready. This way the
 * user's own message reaches their UI *before* slow connector calls
 * complete — the chat feels live instead of arriving in batches.
 */
export type Emit = (
	event:
		| BroadcastMessage
		| BroadcastMessageStart
		| BroadcastMessageDelta
		| BroadcastMessageEnd
		| BroadcastMessageError
		| BroadcastApprovalCreated
		| BroadcastApprovalUpdated
		| BroadcastSystem
) => void;

export interface FinnHooks {
	onUserMessage?: (msg: { channel_id: string; body: string }, emit: Emit) => Promise<void> | void;
	onApprovalDecide?: (
		msg: {
			approval_id: string;
			decision: 'approve' | 'reject';
			targets?: string[];
			reject_reason?: string;
		},
		emit: Emit
	) => Promise<void> | void;
	onForwardMessage?: (
		msg: { message_id: string; target_agent_ids: string[] },
		emit: Emit
	) => Promise<void> | void;
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

			const emit: Emit = (event) => broadcast(wss, event);

			if (parsed.type === 'user_message') {
				if (!hooks.onUserMessage) {
					send(ws, { type: 'system', body: 'no user-message handler configured' });
					return;
				}
				try {
					await hooks.onUserMessage(
						{ channel_id: parsed.channel_id, body: parsed.body },
						emit
					);
				} catch (err) {
					emit({ type: 'system', body: `error: ${(err as Error).message}` });
				}
				return;
			}

			if (parsed.type === 'approval_decide') {
				if (!hooks.onApprovalDecide) {
					send(ws, { type: 'system', body: 'no approval-decide handler configured' });
					return;
				}
				try {
					await hooks.onApprovalDecide(
						{
							approval_id: parsed.approval_id,
							decision: parsed.decision,
							targets: parsed.targets,
							reject_reason: parsed.reject_reason
						},
						emit
					);
				} catch (err) {
					emit({ type: 'system', body: `approval error: ${(err as Error).message}` });
				}
				return;
			}

			if (parsed.type === 'forward_message') {
				if (!hooks.onForwardMessage) {
					send(ws, { type: 'system', body: 'no forward-message handler configured' });
					return;
				}
				try {
					await hooks.onForwardMessage(
						{
							message_id: parsed.message_id,
							target_agent_ids: parsed.target_agent_ids
						},
						emit
					);
				} catch (err) {
					emit({ type: 'system', body: `forward error: ${(err as Error).message}` });
				}
				return;
			}
		});
	});

	attached = wss;
	setActiveWss(wss);
	return wss;
}

/**
 * Broadcast a state-change event from outside the WS hook path
 * (e.g. from a REST handler). Silently no-ops if no WS server is
 * attached, so unit tests / scripts that exercise the same code
 * paths don't crash.
 */
export function broadcastStateChange(event: BroadcastStateChanged): void {
	const wss = getActiveWss();
	if (!wss) return;
	broadcast(wss, event);
}

/**
 * Broadcast any outbound event from outside the WS hook path. Used by
 * REST handlers that need to surface a chat message (e.g. system
 * messages on membership changes) live to all connected clients.
 */
export function broadcastEvent(event: FinnOutbound): void {
	const wss = getActiveWss();
	if (!wss) return;
	broadcast(wss, event);
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
