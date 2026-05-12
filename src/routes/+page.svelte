<script lang="ts">
	import { onMount, onDestroy, tick } from 'svelte';
	import MessageBubble from '$lib/ui/MessageBubble.svelte';
	import Modal from '$lib/ui/Modal.svelte';
	import ChannelForm from '$lib/ui/ChannelForm.svelte';
	import type { ChannelFormPayload } from '$lib/ui/ChannelForm.svelte';
	import AgentForm from '$lib/ui/AgentForm.svelte';
	import type { AgentFormPayload } from '$lib/ui/AgentForm.svelte';
	import MentionPopup from '$lib/ui/MentionPopup.svelte';
	import type {
		ChannelInfo,
		AgentInfo,
		DBMessage,
		ApprovalSnapshot,
		TokenUsage,
		WSInbound
	} from '$lib/ui/types';

	type UIMessage = {
		id: string;
		channelId: string;
		sender: 'user' | 'agent' | 'system';
		senderId: string | null;
		body: string;
		ts: number;
		hiddenAt: number | null;
		/** True between `message_start` and `message_end` for streaming
		 * agent replies (ADR-0013). The bubble renders a cursor while
		 * this is true; finalises (e.g. for future markdown rendering)
		 * when it flips back to false. Always false on initial-load /
		 * load-older paths since those rows came from the DB and are
		 * already complete. */
		streaming: boolean;
		/** Set when a `message_error` arrived for this message id mid
		 * stream. The bubble surfaces the error inline; no DB row was
		 * written, so this UIMessage is purely a client-side
		 * presentation of the failure. */
		error: string | null;
		/** Token-usage counters captured from the upstream (issue #43
		 * part B). Set on `message_end` (when the backend reported
		 * usage) or decoded once at load time from `tokensJson`. NULL
		 * for user / system / pre-feature rows / backends without
		 * usage. */
		tokens: TokenUsage | null;
	};

	/**
	 * Decode `tokens_json` from a DB row into the in-memory shape.
	 * Tolerates malformed JSON (older rows, manually-edited DB) by
	 * falling back to null — a missing footer is preferable to a
	 * crashed channel view.
	 */
	function decodeTokens(raw: string | null | undefined): TokenUsage | null {
		if (!raw) return null;
		try {
			const parsed = JSON.parse(raw);
			if (
				parsed &&
				typeof parsed.input === 'number' &&
				typeof parsed.output === 'number' &&
				typeof parsed.total === 'number'
			) {
				return { input: parsed.input, output: parsed.output, total: parsed.total };
			}
		} catch {
			// fall through to null
		}
		return null;
	}

	/* ---------- WebSocket + bootstrap state ---------- */

	let ws: WebSocket | null = $state(null);
	let connected = $state(false);
	let bootstrapError: string | null = $state(null);

	/* ---------- domain state ---------- */

	let channels = $state<ChannelInfo[]>([]);
	let activeChannelId = $state<string | null>(null);
	let activeChannel = $derived(channels.find((c) => c.id === activeChannelId) ?? null);

	let allAgents = $state<AgentInfo[]>([]);
	let members = $state<Record<string, AgentInfo[]>>({});
	let messagesByChannel = $state<Record<string, UIMessage[]>>({});
	/**
	 * Map from streaming-message id → the channel id its bubble lives
	 * in. Populated on `message_start`, drained on `message_end` /
	 * `message_error`. Used so subsequent `message_delta` events can
	 * find the bubble without scanning every channel's message list.
	 * Plain object (not $state) because we never need reactivity on
	 * the map itself — it's strictly a routing index.
	 */
	const streamingChannelById: Record<string, string> = {};
	let approvalsByMessage = $state<Record<string, ApprovalSnapshot>>({});
	/** Per channel: timestamp of the OLDEST message we have loaded.
	 * Used to fire 'load older' fetches with a `before=` cursor. */
	let oldestLoadedTs = $state<Record<string, number>>({});
	/** Per channel: true once we've fetched older messages and the
	 * server returned fewer than the page size, meaning there are no
	 * more to fetch. Disables the 'Load older' button. */
	let reachedStart = $state<Record<string, boolean>>({});

	/* ---------- composer ---------- */

	let draft = $state('');
	let composer: HTMLTextAreaElement | null = $state(null);

	/* ---------- mention autocomplete ---------- */

	type MentionContext = {
		/** start index of the `@` in the textarea value */
		startIdx: number;
		/** the partial token (without `@`) currently being typed */
		query: string;
	};
	let mentionCtx = $state<MentionContext | null>(null);
	let mentionIndex = $state(0);
	const mentionCandidates = $derived.by(() => {
		if (!mentionCtx || !activeChannelId) return [] as AgentInfo[];
		const list = members[activeChannelId] ?? [];
		const q = mentionCtx.query.toLowerCase();
		return list
			.filter((m) => m.enabled)
			.filter((m) => m.name.toLowerCase().startsWith(q))
			.slice(0, 6);
	});

	/* ---------- search ---------- */

	let searchQuery = $state('');
	let searchHits = $state<UIMessage[]>([]);
	let searchActive = $derived(searchQuery.trim().length > 0);

	/* ---------- filters ---------- */

	/** agent ids to hide. Empty set = show all. */
	let hiddenAgentIds = $state<Set<string>>(new Set());
	let hideSystem = $state(false);
	let hideRejected = $state(false);
	/** Show messages that the user has groomed-hidden. Off by default;
	 * groomed messages stay out of the channel view until toggled on. */
	let showGroomed = $state(false);

	/* ---------- modals + sidebar menus ---------- */

	type ModalState =
		| { kind: 'none' }
		| { kind: 'create_channel' }
		| { kind: 'edit_channel'; channelId: string }
		| { kind: 'create_agent' }
		| { kind: 'edit_agent'; agentId: string };
	let modal = $state<ModalState>({ kind: 'none' });
	let openMenu = $state<string | null>(null);

	// Issue #90: collapsible sidebar sections. Persist the
	// collapsed state per section in localStorage so the user
	// keeps their preference across reloads. Default: both
	// expanded.
	function readCollapsed(key: string): boolean {
		if (typeof localStorage === 'undefined') return false;
		return localStorage.getItem(`finn.sidebar.collapsed.${key}`) === '1';
	}
	function writeCollapsed(key: string, v: boolean) {
		if (typeof localStorage === 'undefined') return;
		if (v) localStorage.setItem(`finn.sidebar.collapsed.${key}`, '1');
		else localStorage.removeItem(`finn.sidebar.collapsed.${key}`);
	}
	let channelsCollapsed = $state(false);
	let agentsCollapsed = $state(false);
	function toggleSection(which: 'channels' | 'agents') {
		if (which === 'channels') {
			channelsCollapsed = !channelsCollapsed;
			writeCollapsed('channels', channelsCollapsed);
		} else {
			agentsCollapsed = !agentsCollapsed;
			writeCollapsed('agents', agentsCollapsed);
		}
	}
	let editAgentData = $state<{
		id: string;
		name: string;
		connectorType: 'openclaw' | 'openai-compatible' | 'anthropic-stub';
		enabled: boolean;
		config: Record<string, unknown>;
	} | null>(null);

	/* ---------- scroll handling ---------- */

	let messageScroller: HTMLElement | null = $state(null);
	/** Suppresses the next auto-scroll-to-bottom. Set when we prepend
	 * older messages so the user's scroll position is preserved. */
	let suppressNextScroll = false;

	/**
	 * Pixels from the bottom within which we still consider the user
	 * "at the bottom". Above this, the user has deliberately scrolled
	 * up to read history and we leave them there — don't fight them.
	 * (ADR-0016 §8.) */
	const BOTTOM_THRESHOLD_PX = 50;

	function isUserAtBottom(scroller: HTMLElement): boolean {
		const dist = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
		return dist <= BOTTOM_THRESHOLD_PX;
	}

	function snapToBottom(scroller: HTMLElement): void {
		scroller.scrollTop = scroller.scrollHeight;
	}

	/**
	 * Scroll discipline (ADR-0016 §8).
	 *
	 * One ResizeObserver on the messages-container. Any layout change
	 * that grows scrollHeight — streaming deltas, message_end
	 * markdown finalisation, late approval_created adding buttons
	 * below a settled bubble, image loads, font swaps — reaches us
	 * here. If the user was at-or-near the bottom (<=50 px), we snap
	 * to the new bottom; if they had scrolled up, we leave them.
	 *
	 * Replaces the per-event scroll trigger that previously tracked
	 * messagesByChannel.length and tail.body.length — that approach
	 * missed approval_created (mutates approvalsByMessage, not
	 * messages) and missed bubble-shape changes that don't change a
	 * length (markdown finalisation, footer addition).
	 *
	 * `suppressNextScroll` is retained for the load-older path — a
	 * deliberate scroll-position preservation that should override
	 * the auto-snap for one observer firing.
	 */
	$effect(() => {
		const scroller = messageScroller;
		if (!scroller) return;
		if (typeof ResizeObserver === 'undefined') return;

		let wasAtBottom = true;

		const trackPosition = () => {
			wasAtBottom = isUserAtBottom(scroller);
		};
		scroller.addEventListener('scroll', trackPosition, { passive: true });

		const observer = new ResizeObserver(() => {
			if (suppressNextScroll) {
				suppressNextScroll = false;
				wasAtBottom = isUserAtBottom(scroller);
				return;
			}
			if (wasAtBottom) {
				snapToBottom(scroller);
			}
		});

		// Observe both the scroller (height changes from window
		// resize) and its scrollable child container so internal
		// growth (new bubbles, taller bubbles) reaches us.
		observer.observe(scroller);
		for (const child of Array.from(scroller.children)) {
			if (child instanceof HTMLElement) observer.observe(child);
		}

		return () => {
			scroller.removeEventListener('scroll', trackPosition);
			observer.disconnect();
		};
	});

	/**
	 * Initial scroll on channel switch. The ResizeObserver above
	 * handles ongoing growth, but a freshly-loaded channel needs a
	 * one-shot snap-to-bottom: the scroller already exists, the
	 * messages just landed inside it, so the observer fires — but
	 * `wasAtBottom` was sampled while the previous channel's content
	 * was still showing, and may have been false. Force the snap on
	 * activeChannel change to give the user the standard
	 * "land at the latest message" experience.
	 */
	$effect(() => {
		if (!activeChannelId) return;
		const scroller = messageScroller;
		if (!scroller) return;
		// Read the message list to register dependency — fires when
		// the channel's first messages land too.
		const list = messagesByChannel[activeChannelId];
		if (!list) return;
		void list.length;
		void tick().then(() => {
			if (!suppressNextScroll) snapToBottom(scroller);
		});
	});

	/* ---------- derived: visible messages ---------- */

	const baseMessages = $derived(activeChannelId ? messagesByChannel[activeChannelId] ?? [] : []);
	const activeMembers = $derived(activeChannelId ? members[activeChannelId] ?? [] : []);

	const visibleMessages = $derived.by(() => {
		const list = baseMessages;
		if (!searchActive) {
			return list.filter((m) => {
				if (m.hiddenAt !== null && !showGroomed) return false;
				if (hideSystem && m.sender === 'system') return false;
				if (m.sender === 'agent' && m.senderId && hiddenAgentIds.has(m.senderId)) return false;
				if (hideRejected) {
					const a = approvalsByMessage[m.id];
					if (a && a.status === 'rejected') return false;
				}
				return true;
			});
		}
		// Search-mode shows search hits scoped to the active channel.
		return searchHits;
	});

	/* ---------- helpers ---------- */

	function nameOfSender(m: UIMessage): string {
		if (m.sender === 'user') return 'you';
		if (m.sender === 'system') return 'system';
		const id = m.senderId;
		if (!id) return 'agent';
		const agent = activeMembers.find((a) => a.id === id) ?? allAgents.find((a) => a.id === id);
		return agent?.name ?? id;
	}

	/* ---------- data fetching ---------- */

	/**
	 * Hardcoded fallback for the initial-load budget when neither a
	 * per-channel override nor a global setting can be read. The
	 * full precedence chain (ADR-0019) is:
	 *   channel override → global default → this constant.
	 *
	 * 200 KB is the same value the seed migration writes into
	 * `settings_global.kb_budget_default`; keeping it here as a
	 * code-side fallback means a missing or unreachable
	 * `/api/settings` degrades to identical behaviour rather than to
	 * zero (which would render an empty channel) or unbounded.
	 *
	 * Per-channel and global tuning live in the `/settings` surface
	 * (ADR-0019, issue #18).
	 */
	const KB_BUDGET_FALLBACK = 200;

	/**
	 * Per-channel effective KB budget, populated on first load and
	 * refreshed when the settings broadcast tells us the relevant
	 * scope changed. Missing entry = use the global default (cached
	 * separately below) or the hardcoded fallback.
	 */
	let channelKbBudget = $state<Record<string, number>>({});
	let globalKbBudget = $state<number>(KB_BUDGET_FALLBACK);

	async function loadSettingsForChannel(channelId: string): Promise<number> {
		try {
			const res = await fetch(`/api/settings?channelId=${encodeURIComponent(channelId)}`);
			if (!res.ok) return globalKbBudget;
			const data = await res.json();
			const eff = data?.channel?.effective?.kbBudget;
			const globalDefault = data?.global?.kbBudgetDefault;
			if (typeof globalDefault === 'number') globalKbBudget = globalDefault;
			if (typeof eff === 'number') {
				channelKbBudget = { ...channelKbBudget, [channelId]: eff };
				return eff;
			}
			return globalDefault ?? KB_BUDGET_FALLBACK;
		} catch {
			return globalKbBudget;
		}
	}

	async function loadChannelData(channelId: string) {
		const budgetKb = await loadSettingsForChannel(channelId);
		const [msgRes, memRes, apprRes] = await Promise.all([
			fetch(`/api/channels/${channelId}/messages?budget=${budgetKb}`),
			fetch(`/api/channels/${channelId}/members`),
			fetch(`/api/channels/${channelId}/approvals`)
		]);
		if (!msgRes.ok || !memRes.ok || !apprRes.ok) {
			throw new Error(
				`channel ${channelId} fetch failed: ${msgRes.status}/${memRes.status}/${apprRes.status}`
			);
		}
		const msgData = (await msgRes.json()) as {
			messages: DBMessage[];
			has_more?: boolean;
		};
		const memData = (await memRes.json()) as { members: AgentInfo[] };
		const apprData = (await apprRes.json()) as { approvals: ApprovalSnapshot[] };

		const ui: UIMessage[] = msgData.messages.map((m) => ({
			id: m.id,
			channelId: m.channelId,
			sender: m.senderType,
			senderId: m.senderId,
			body: m.body,
			hiddenAt: m.hiddenAt ?? null,
			ts: m.createdAt,
			streaming: false,
			error: null,
			tokens: decodeTokens(m.tokensJson)
		}));
		messagesByChannel = { ...messagesByChannel, [channelId]: ui };
		oldestLoadedTs = {
			...oldestLoadedTs,
			[channelId]: ui.length > 0 ? ui[0]!.ts : Number.MAX_SAFE_INTEGER
		};
		// Budget mode: server tells us authoritatively whether more
		// history exists.
		reachedStart = { ...reachedStart, [channelId]: msgData.has_more === false };

		members = { ...members, [channelId]: memData.members };
		const next = { ...approvalsByMessage };
		for (const a of apprData.approvals) next[a.messageId] = a;
		approvalsByMessage = next;
	}

	async function loadOlder() {
		if (!activeChannelId) return;
		if (reachedStart[activeChannelId]) return;
		const before = oldestLoadedTs[activeChannelId];
		if (before === undefined) return;

		const res = await fetch(
			`/api/channels/${activeChannelId}/messages?limit=200&before=${before}`
		);
		if (!res.ok) return;
		const data = (await res.json()) as { messages: DBMessage[] };

		if (data.messages.length === 0) {
			reachedStart = { ...reachedStart, [activeChannelId]: true };
			return;
		}

		// Preserve scroll position: remember where we are, prepend, then
		// shift the scroll back down by the height of the prepended block.
		const scroller = messageScroller;
		const prevScrollHeight = scroller?.scrollHeight ?? 0;
		const prevScrollTop = scroller?.scrollTop ?? 0;
		suppressNextScroll = true;

		const older: UIMessage[] = data.messages.map((m) => ({
			id: m.id,
			channelId: m.channelId,
			sender: m.senderType,
			senderId: m.senderId,
			body: m.body,
			hiddenAt: m.hiddenAt ?? null,
			ts: m.createdAt,
			streaming: false,
			error: null,
			tokens: decodeTokens(m.tokensJson)
		}));
		const existing = messagesByChannel[activeChannelId] ?? [];
		messagesByChannel = {
			...messagesByChannel,
			[activeChannelId]: [...older, ...existing]
		};
		oldestLoadedTs = {
			...oldestLoadedTs,
			[activeChannelId]: older[0]!.ts
		};
		if (data.messages.length < 200) {
			reachedStart = { ...reachedStart, [activeChannelId]: true };
		}

		// Also fetch any approvals for these older messages.
		const apprRes = await fetch(`/api/channels/${activeChannelId}/approvals?limit=1000`);
		if (apprRes.ok) {
			const ad = (await apprRes.json()) as { approvals: ApprovalSnapshot[] };
			const next = { ...approvalsByMessage };
			for (const a of ad.approvals) next[a.messageId] = a;
			approvalsByMessage = next;
		}

		await tick();
		if (scroller) {
			scroller.scrollTop = scroller.scrollHeight - prevScrollHeight + prevScrollTop;
		}
	}

	async function loadChannels() {
		const res = await fetch('/api/channels');
		if (!res.ok) throw new Error(`/api/channels ${res.status}`);
		const data = (await res.json()) as { channels: ChannelInfo[] };
		channels = data.channels;
	}

	async function loadAgents() {
		const res = await fetch('/api/agents');
		if (!res.ok) throw new Error(`/api/agents ${res.status}`);
		const data = (await res.json()) as { agents: AgentInfo[] };
		allAgents = data.agents;
	}

	async function bootstrap() {
		try {
			await Promise.all([loadChannels(), loadAgents()]);
			if (channels.length === 0) {
				bootstrapError = 'no channels in DB; run `npm run db:seed` or use the + button';
			} else {
				activeChannelId = channels[0]!.id;
				await Promise.all(channels.map((c) => loadChannelData(c.id)));
			}
			connect();
		} catch (err) {
			bootstrapError = (err as Error).message;
		}
	}

	function connect() {
		const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const socket = new WebSocket(`${proto}//${location.host}/ws`);
		socket.onopen = () => {
			connected = true;
		};
		socket.onclose = () => {
			connected = false;
		};
		socket.onmessage = (ev) => {
			let msg: WSInbound;
			try {
				msg = JSON.parse(ev.data);
			} catch {
				return;
			}
			void handleWsMessage(msg);
		};
		ws = socket;
	}

	async function handleWsMessage(msg: WSInbound) {
		if (msg.type === 'message') {
			const channelId = msg.channel_id;
			const list = messagesByChannel[channelId] ?? [];
			messagesByChannel = {
				...messagesByChannel,
				[channelId]: [
					...list,
					{
						id: msg.id,
						channelId,
						sender: msg.sender,
						senderId: msg.sender_id,
						body: msg.body,
						hiddenAt: null,
						ts: msg.ts,
						streaming: false,
						error: null,
						tokens: null
					}
				]
			};
			return;
		}
		if (msg.type === 'message_start') {
			// New streaming agent reply: insert an empty bubble so the
			// user sees something immediately, before any token has
			// arrived. Subsequent `message_delta` events append to body;
			// `message_end` finalises; `message_error` flips the bubble
			// to its failed variant.
			const channelId = msg.channel_id;
			const list = messagesByChannel[channelId] ?? [];
			streamingChannelById[msg.id] = channelId;
			messagesByChannel = {
				...messagesByChannel,
				[channelId]: [
					...list,
					{
						id: msg.id,
						channelId,
						sender: 'agent',
						senderId: msg.sender_id,
						body: '',
						hiddenAt: null,
						ts: msg.ts,
						streaming: true,
						error: null,
						tokens: null
					}
				]
			};
			return;
		}
		if (msg.type === 'message_delta') {
			const channelId = streamingChannelById[msg.id];
			if (!channelId) return; // unknown id; ignore
			const list = messagesByChannel[channelId];
			if (!list) return;
			messagesByChannel = {
				...messagesByChannel,
				[channelId]: list.map((m) =>
					m.id === msg.id ? { ...m, body: m.body + msg.delta } : m
				)
			};
			return;
		}
		if (msg.type === 'message_end') {
			const channelId = streamingChannelById[msg.id];
			if (!channelId) return;
			const list = messagesByChannel[channelId];
			if (!list) return;
			// Reconcile against the server's final body in case the
			// stream and the assembled deltas drifted (frame splits,
			// dropped chunk on retry, etc.). The server's body is the
			// authoritative one, since it is what the DB row stores.
			// Tokens (if reported by the upstream) land here too and
			// drive the bubble's footer; absent means no footer.
			const tokens = msg.tokens ?? null;
			messagesByChannel = {
				...messagesByChannel,
				[channelId]: list.map((m) =>
					m.id === msg.id
						? { ...m, body: msg.body, streaming: false, tokens }
						: m
				)
			};
			delete streamingChannelById[msg.id];
			return;
		}
		if (msg.type === 'message_error') {
			const channelId = streamingChannelById[msg.id];
			if (!channelId) return;
			const list = messagesByChannel[channelId];
			if (!list) return;
			messagesByChannel = {
				...messagesByChannel,
				[channelId]: list.map((m) =>
					m.id === msg.id
						? { ...m, streaming: false, error: msg.error }
						: m
				)
			};
			delete streamingChannelById[msg.id];
			return;
		}
		if (msg.type === 'approval_created' || msg.type === 'approval_updated') {
			approvalsByMessage = {
				...approvalsByMessage,
				[msg.approval.messageId]: msg.approval
			};
			return;
		}
		if (msg.type === 'state_changed') {
			if (msg.entity === 'channel') {
				await loadChannels();
				if (msg.action === 'created' && !messagesByChannel[msg.id]) {
					await loadChannelData(msg.id);
				} else if (msg.action === 'deleted' && activeChannelId === msg.id) {
					activeChannelId = channels[0]?.id ?? null;
				}
			} else if (msg.entity === 'agent') {
				await loadAgents();
				if (activeChannelId) await loadChannelData(activeChannelId);
			} else if (msg.entity === 'channel_member') {
				if (messagesByChannel[msg.id] !== undefined) {
					await loadChannelData(msg.id);
				}
			} else if (msg.entity === 'settings') {
				// Settings change (ADR-0019). Two scopes:
				//   id === 'global'    → global default changed; re-fetch
				//                        for every loaded channel, since any
				//                        channel without an override picks up
				//                        the new global value.
				//   id === <channelId> → single-channel override changed;
				//                        only that channel's effective values
				//                        moved.
				//
				// We deliberately do NOT reload the full message body for
				// the affected channels here — a KB-budget change only
				// affects *initial* load, not in-place display. The next
				// time the user opens the channel, the new budget applies.
				// Tracking the cached `effective` value is enough.
				if (msg.id === 'global') {
					for (const channelId of Object.keys(messagesByChannel)) {
						await loadSettingsForChannel(channelId);
					}
				} else if (messagesByChannel[msg.id] !== undefined) {
					await loadSettingsForChannel(msg.id);
				}
			} else if (msg.entity === 'message') {
				// Visibility change. Update the in-memory record without
				// a full reload so the bubble re-derives its filter
				// status.
				const channelId = (msg.extra?.channel_id as string | undefined) ?? null;
				const hidden = (msg.extra?.hidden as boolean | undefined) ?? false;
				if (channelId && messagesByChannel[channelId]) {
					messagesByChannel = {
						...messagesByChannel,
						[channelId]: messagesByChannel[channelId]!.map((m) =>
							m.id === msg.id ? { ...m, hiddenAt: hidden ? Date.now() : null } : m
						)
					};
				}
			}
			return;
		}
	}

	/* ---------- composer + mentions ---------- */

	function detectMentionAtCaret() {
		if (!composer) return;
		const value = composer.value;
		const caret = composer.selectionStart ?? value.length;
		// Walk backwards from the caret to find a `@` that is either at
		// position 0 or preceded by whitespace.
		let i = caret - 1;
		while (i >= 0) {
			const ch = value[i]!;
			if (ch === '@') {
				const before = i === 0 ? ' ' : value[i - 1]!;
				if (/\s/.test(before)) {
					const partial = value.slice(i + 1, caret);
					// Only continue if partial is all word-ish chars.
					if (/^[\p{L}\p{N}_.\-]*$/u.test(partial)) {
						mentionCtx = { startIdx: i, query: partial };
						mentionIndex = 0;
						return;
					}
				}
				break;
			}
			if (/\s/.test(ch)) break;
			if (!/[\p{L}\p{N}_.\-]/u.test(ch)) break;
			i--;
		}
		mentionCtx = null;
	}

	function selectMention(agent: AgentInfo) {
		if (!composer || !mentionCtx) return;
		const value = composer.value;
		const caret = composer.selectionStart ?? value.length;
		const before = value.slice(0, mentionCtx.startIdx);
		const after = value.slice(caret);
		const inserted = `@${agent.name} `;
		const newValue = before + inserted + after;
		draft = newValue;
		mentionCtx = null;
		const nextCaret = before.length + inserted.length;
		queueMicrotask(() => {
			composer?.focus();
			composer?.setSelectionRange(nextCaret, nextCaret);
		});
	}

	/* ---------- sending + decisions ---------- */

	function send() {
		const body = draft.trim();
		if (!body || !ws || ws.readyState !== WebSocket.OPEN || !activeChannelId) return;
		ws.send(JSON.stringify({ type: 'user_message', channel_id: activeChannelId, body }));
		draft = '';
		mentionCtx = null;
		// After clearing draft, shrink the textarea back to its base
		// height instead of staying expanded from the previous message.
		queueMicrotask(autosizeComposer);
	}

	async function setMessageHidden(messageId: string, hidden: boolean) {
		const res = await fetch(`/api/messages/${messageId}/visibility`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ hidden })
		});
		if (!res.ok) {
			alert(`failed: ${res.status}`);
		}
		// The state_changed broadcast will update the in-memory map.
	}

	function decideApproval(
		approvalId: string,
		decision: 'approve' | 'reject',
		targets: string[],
		reason: string
	) {
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		ws.send(
			JSON.stringify({
				type: 'approval_decide',
				approval_id: approvalId,
				decision,
				targets: decision === 'approve' ? targets : undefined,
				reject_reason: decision === 'reject' ? reason : undefined
			})
		);
	}

	/**
	 * Manually forward an existing message to one or more channel-
	 * member agents (issue #52). Skips the pending approval stage
	 * server-side; the user's deliberate confirm click *is* the
	 * approval. The originating bubble will get a `routed`
	 * approval row attached to it for audit, plus the regular
	 * per-target streaming bubbles for each forwarded reply.
	 */
	function forwardMessage(messageId: string, targetAgentIds: string[]) {
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		if (targetAgentIds.length === 0) return;
		ws.send(
			JSON.stringify({
				type: 'forward_message',
				message_id: messageId,
				target_agent_ids: targetAgentIds
			})
		);
	}

	function onComposerKey(e: KeyboardEvent) {
		// Mention popup navigation comes first.
		if (mentionCtx && mentionCandidates.length > 0) {
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				mentionIndex = (mentionIndex + 1) % mentionCandidates.length;
				return;
			}
			if (e.key === 'ArrowUp') {
				e.preventDefault();
				mentionIndex =
					(mentionIndex - 1 + mentionCandidates.length) % mentionCandidates.length;
				return;
			}
			if (e.key === 'Enter' || e.key === 'Tab') {
				e.preventDefault();
				const choice = mentionCandidates[mentionIndex];
				if (choice) selectMention(choice);
				return;
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				mentionCtx = null;
				return;
			}
		}
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			send();
		}
	}

	function onComposerInput() {
		detectMentionAtCaret();
		autosizeComposer();
	}

	// Issue #89: grow the composer textarea with its content up to a
	// sensible cap, then scroll inside the box. Pure DOM manipulation
	// is fine here because there is exactly one composer per page and
	// the resize must happen synchronously with the input event to
	// avoid a one-frame layout flicker.
	const COMPOSER_MAX_HEIGHT_PX = 220; // ~10 rows at our font size.
	function autosizeComposer() {
		if (!composer) return;
		composer.style.height = 'auto';
		const next = Math.min(composer.scrollHeight, COMPOSER_MAX_HEIGHT_PX);
		composer.style.height = `${next}px`;
		// Once we hit the cap, the textarea's own scroll takes over;
		// the height stays put and the user scrolls inside the box.
		composer.style.overflowY =
			composer.scrollHeight > COMPOSER_MAX_HEIGHT_PX ? 'auto' : 'hidden';
	}

	/* ---------- channel + agent CRUD ---------- */

	function pickChannel(id: string) {
		activeChannelId = id;
		openMenu = null;
		// Reset search and scroll state per channel.
		searchQuery = '';
		searchHits = [];
	}

	async function submitChannelForm(payload: ChannelFormPayload) {
		if (payload.mode === 'create') {
			const res = await fetch('/api/channels', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					name: payload.name,
					description: payload.description,
					member_agent_ids: payload.member_agent_ids ?? []
				})
			});
			if (!res.ok) throw new Error((await res.json()).message ?? `HTTP ${res.status}`);
			const created = (await res.json()) as { id: string };
			modal = { kind: 'none' };
			activeChannelId = created.id;
		} else {
			if (modal.kind !== 'edit_channel') return;
			const channelId = modal.channelId;
			const channelRes = await fetch(`/api/channels/${channelId}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name: payload.name, description: payload.description })
			});
			if (!channelRes.ok)
				throw new Error((await channelRes.json()).message ?? `HTTP ${channelRes.status}`);

			for (const agentId of payload.add_member_ids ?? []) {
				const r = await fetch(`/api/channels/${channelId}/members`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ agent_id: agentId })
				});
				if (!r.ok) throw new Error(`add member: ${r.status}`);
			}
			for (const agentId of payload.remove_member_ids ?? []) {
				const r = await fetch(`/api/channels/${channelId}/members/${agentId}`, {
					method: 'DELETE'
				});
				if (!r.ok) throw new Error(`remove member: ${r.status}`);
			}
			modal = { kind: 'none' };
		}
	}

	async function submitAgentForm(payload: AgentFormPayload) {
		if (payload.mode === 'create') {
			const res = await fetch('/api/agents', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					name: payload.name,
					enabled: payload.enabled,
					config: payload.config
				})
			});
			if (!res.ok) throw new Error((await res.json()).message ?? `HTTP ${res.status}`);
			modal = { kind: 'none' };
		} else {
			if (modal.kind !== 'edit_agent') return;
			const res = await fetch(`/api/agents/${modal.agentId}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					name: payload.name,
					enabled: payload.enabled,
					config: payload.config
				})
			});
			if (!res.ok) throw new Error((await res.json()).message ?? `HTTP ${res.status}`);
			modal = { kind: 'none' };
			editAgentData = null;
		}
	}

	async function archiveChannel(channelId: string) {
		if (!confirm('Archive this channel? Past messages remain accessible via SQL.')) return;
		const res = await fetch(`/api/channels/${channelId}`, { method: 'DELETE' });
		if (!res.ok) {
			alert(`failed: ${res.status}`);
			return;
		}
		openMenu = null;
	}

	async function archiveAgent(agentId: string) {
		if (!confirm('Archive this agent? It will no longer dispatch; past messages remain attributed.'))
			return;
		const res = await fetch(`/api/agents/${agentId}`, { method: 'DELETE' });
		if (!res.ok) {
			alert(`failed: ${res.status}`);
			return;
		}
		openMenu = null;
	}

	async function toggleAgentEnabled(agent: AgentInfo) {
		const res = await fetch(`/api/agents/${agent.id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ enabled: !agent.enabled })
		});
		if (!res.ok) alert(`failed: ${res.status}`);
		openMenu = null;
	}

	async function openEditAgent(agentId: string) {
		const res = await fetch(`/api/agents/${agentId}`);
		if (!res.ok) {
			alert(`failed: ${res.status}`);
			return;
		}
		const data = await res.json();
		editAgentData = {
			id: data.id,
			name: data.name,
			connectorType: data.connectorType,
			enabled: data.enabled,
			config: data.config
		};
		modal = { kind: 'edit_agent', agentId };
		openMenu = null;
	}

	function openEditChannel(channelId: string) {
		modal = { kind: 'edit_channel', channelId };
		openMenu = null;
	}

	function toggleMenu(key: string) {
		openMenu = openMenu === key ? null : key;
	}

	const editChannelData = $derived.by(() => {
		if (modal.kind !== 'edit_channel') return null;
		const id = modal.channelId;
		return channels.find((c) => c.id === id) ?? null;
	});

	const editChannelMemberIds = $derived.by(() => {
		if (modal.kind !== 'edit_channel') return [];
		const id = modal.channelId;
		return (members[id] ?? []).map((m) => m.id);
	});

	/* ---------- search ---------- */

	let searchDebounce: ReturnType<typeof setTimeout> | null = null;

	function onSearchInput() {
		if (searchDebounce) clearTimeout(searchDebounce);
		const q = searchQuery.trim();
		if (q.length === 0) {
			searchHits = [];
			return;
		}
		searchDebounce = setTimeout(() => {
			void runSearch(q);
		}, 200);
	}

	async function runSearch(q: string) {
		if (!activeChannelId) return;
		const res = await fetch(
			`/api/channels/${activeChannelId}/search?q=${encodeURIComponent(q)}`
		);
		if (!res.ok) return;
		const data = (await res.json()) as { messages: DBMessage[] };
		searchHits = data.messages.map((m) => ({
			id: m.id,
			channelId: m.channelId,
			sender: m.senderType,
			senderId: m.senderId,
			body: m.body,
			hiddenAt: m.hiddenAt ?? null,
			ts: m.createdAt,
			streaming: false,
			error: null,
			tokens: decodeTokens(m.tokensJson)
		}));
	}

	/* ---------- export ---------- */

	function exportChannel() {
		if (!activeChannelId) return;
		// Trigger a browser download. Server sets content-disposition.
		window.location.href = `/api/channels/${activeChannelId}/export?format=md`;
	}

	/* ---------- filter toggles ---------- */

	function toggleSenderFilter(agentId: string) {
		const next = new Set(hiddenAgentIds);
		if (next.has(agentId)) next.delete(agentId);
		else next.add(agentId);
		hiddenAgentIds = next;
	}

	onMount(() => {
		// Restore collapsed sidebar sections from localStorage (#90).
		channelsCollapsed = readCollapsed('channels');
		agentsCollapsed = readCollapsed('agents');
		bootstrap();
	});

	onDestroy(() => {
		ws?.close();
		if (searchDebounce) clearTimeout(searchDebounce);
	});
</script>

<div class="root">
	<aside>
		<div class="brand">
			<img
				src="/finn-brand.webp"
				alt=""
				width="140"
				height="140"
				class="brand-img"
			/>
			<div class="brand-row">
				<h1>finn</h1>
				<span class="status" class:on={connected}>{connected ? '●' : '○'}</span>
			</div>
		</div>

		<!-- Protocol viewer: styled as a sidebar nav row matching the
			 channel/agent rows for visual consistency (#90 item 3). -->
		<div class="section nav-section">
			<a class="nav-row" href="/protocol">
				<span class="nav-icon">☰</span>
				<span>Protocol viewer</span>
			</a>
		</div>

		<div class="section">
			<div class="section-header">
				<button
					class="section-title-btn"
					type="button"
					aria-expanded={!channelsCollapsed}
					title={channelsCollapsed ? 'expand channels' : 'collapse channels'}
					onclick={() => toggleSection('channels')}
				>
					<span class="caret">{channelsCollapsed ? '▸' : '▾'}</span>
					<span class="section-title">channels</span>
				</button>
				<button class="add-btn" title="add channel" onclick={() => (modal = { kind: 'create_channel' })}>+</button>
			</div>
			{#if !channelsCollapsed}
			{#each channels as c (c.id)}
				<div class="row-wrapper">
					<button
						class="channel-row"
						class:active={c.id === activeChannelId}
						onclick={() => pickChannel(c.id)}
					>
						<span class="hash">#</span>{c.name}
					</button>
					<button class="row-menu-btn" title="actions" onclick={() => toggleMenu(`ch:${c.id}`)}>⋯</button>
					{#if openMenu === `ch:${c.id}`}
						<div class="menu" role="menu">
							<button onclick={() => openEditChannel(c.id)}>Edit</button>
							<button onclick={() => archiveChannel(c.id)}>Archive</button>
						</div>
					{/if}
				</div>
			{/each}
			{/if}
		</div>

		<div class="section">
			<div class="section-header">
				<button
					class="section-title-btn"
					type="button"
					aria-expanded={!agentsCollapsed}
					title={agentsCollapsed ? 'expand agents' : 'collapse agents'}
					onclick={() => toggleSection('agents')}
				>
					<span class="caret">{agentsCollapsed ? '▸' : '▾'}</span>
					<span class="section-title">agents</span>
				</button>
				<button class="add-btn" title="add agent" onclick={() => (modal = { kind: 'create_agent' })}>+</button>
			</div>
			{#if !agentsCollapsed}
			{#each allAgents as a (a.id)}
				<div class="row-wrapper">
					<div class="member-row">
						<span class="dot" class:disabled={!a.enabled}></span>
						<div class="agent-id">
							<span class="agent-name">{a.name}</span>
							<span class="connector">{a.connectorType}</span>
						</div>
					</div>
					<button class="row-menu-btn" title="actions" onclick={() => toggleMenu(`ag:${a.id}`)}>⋯</button>
					{#if openMenu === `ag:${a.id}`}
						<div class="menu" role="menu">
							<button onclick={() => openEditAgent(a.id)}>Edit</button>
							<button onclick={() => toggleAgentEnabled(a)}>
								{a.enabled ? 'Disable' : 'Enable'}
							</button>
							<button onclick={() => archiveAgent(a.id)}>Archive</button>
						</div>
					{/if}
				</div>
			{/each}
			{/if}
		</div>

		{#if activeChannelId && activeMembers.length > 0}
			<div class="section">
				<div class="section-title">in this channel</div>
				{#each activeMembers as m (m.id)}
					<label class="filter-row">
						<input
							type="checkbox"
							checked={!hiddenAgentIds.has(m.id)}
							onchange={() => toggleSenderFilter(m.id)}
						/>
						<span class="dot" class:disabled={!m.enabled}></span>
						<span class="filter-name">{m.name}</span>
					</label>
				{/each}
			</div>

			<div class="section">
				<div class="section-title">filters</div>
				<label class="filter-row">
					<input type="checkbox" bind:checked={hideSystem} />
					<span class="filter-name">hide system messages</span>
				</label>
				<label class="filter-row">
					<input type="checkbox" bind:checked={hideRejected} />
					<span class="filter-name">hide rejected approvals</span>
				</label>
				<label class="filter-row">
					<input type="checkbox" bind:checked={showGroomed} />
					<span class="filter-name">show groomed messages</span>
				</label>
			</div>
		{/if}
	</aside>

	<section class="main">
		<header>
			{#if activeChannel}
				<div class="channel-header-row">
					<div>
						<h1 class="channel-name">#{activeChannel.name}</h1>
						{#if activeChannel.description}
							<div class="channel-desc">{activeChannel.description}</div>
						{/if}
					</div>
					<div class="channel-actions">
						<input
							type="text"
							class="search"
							placeholder="search this channel…"
							bind:value={searchQuery}
							oninput={onSearchInput}
						/>
						<button class="export-btn" onclick={exportChannel} title="export to markdown">
							Export
						</button>
						<!-- Channel-scoped settings shortcut (ADR-0019). The
							 /settings route renders the per-channel pane when
							 the channel id is in the URL fragment. -->
						<a
							class="settings-link"
							href={`/settings#${activeChannel.id}`}
							title="channel settings"
							aria-label="channel settings"
						>
							⚙
						</a>
					</div>
				</div>
			{:else}
				<h1 class="channel-name muted">no channel selected</h1>
			{/if}
		</header>

		{#if bootstrapError}
			<div class="error">bootstrap failed: {bootstrapError}</div>
		{/if}

		<main bind:this={messageScroller}>
			{#if !searchActive && activeChannelId && !reachedStart[activeChannelId]}
				<button class="load-older" onclick={loadOlder}>Load older messages</button>
			{/if}

			{#if searchActive}
				<div class="search-meta">
					{searchHits.length} hit{searchHits.length === 1 ? '' : 's'} for
					<code>{searchQuery.trim()}</code>
				</div>
			{/if}

			{#each visibleMessages as m (m.id)}
				<MessageBubble
					sender={m.sender}
					senderName={nameOfSender(m)}
					senderId={m.senderId}
					body={m.body}
					ts={m.ts}
					streaming={m.streaming}
					error={m.error}
					tokens={m.tokens}
					approval={approvalsByMessage[m.id]}
					members={activeMembers}
					excludeAgentIds={m.senderId ? [m.senderId] : []}
					hidden={m.hiddenAt !== null}
					onDecide={(decision, targets, reason) => {
						const approval = approvalsByMessage[m.id];
						if (!approval) return;
						decideApproval(approval.id, decision, targets, reason);
					}}
					onSetHidden={(h) => void setMessageHidden(m.id, h)}
					onForward={(targets) => forwardMessage(m.id, targets)}
				/>
			{/each}
		</main>

		<footer>
			<div class="composer">
				<MentionPopup
					open={mentionCtx !== null && mentionCandidates.length > 0}
					candidates={mentionCandidates}
					highlightedIndex={mentionIndex}
					onSelect={selectMention}
				/>
				<textarea
					bind:this={composer}
					bind:value={draft}
					oninput={onComposerInput}
					onkeydown={onComposerKey}
					placeholder="message — Enter to send, @-mentions become approval defaults"
					rows="2"
					disabled={!connected || !activeChannelId}
				></textarea>
			</div>
			<button onclick={send} disabled={!connected || !draft.trim() || !activeChannelId}>send</button>
		</footer>
	</section>
</div>

<Modal
	open={modal.kind === 'create_channel'}
	title="Create channel"
	onClose={() => (modal = { kind: 'none' })}
>
	<ChannelForm
		mode="create"
		allAgents={allAgents}
		onSubmit={submitChannelForm}
		onCancel={() => (modal = { kind: 'none' })}
	/>
</Modal>

<Modal
	open={modal.kind === 'edit_channel' && editChannelData !== null}
	title="Edit channel"
	onClose={() => (modal = { kind: 'none' })}
>
	{#if editChannelData}
		<ChannelForm
			mode="edit"
			channel={editChannelData}
			currentMemberIds={editChannelMemberIds}
			allAgents={allAgents}
			onSubmit={submitChannelForm}
			onCancel={() => (modal = { kind: 'none' })}
		/>
	{/if}
</Modal>

<Modal
	open={modal.kind === 'create_agent'}
	title="Create agent"
	onClose={() => (modal = { kind: 'none' })}
>
	<AgentForm mode="create" onSubmit={submitAgentForm} onCancel={() => (modal = { kind: 'none' })} />
</Modal>

<Modal
	open={modal.kind === 'edit_agent' && editAgentData !== null}
	title="Edit agent"
	onClose={() => {
		modal = { kind: 'none' };
		editAgentData = null;
	}}
>
	{#if editAgentData}
		<AgentForm
			mode="edit"
			agent={editAgentData}
			onSubmit={submitAgentForm}
			onCancel={() => {
				modal = { kind: 'none' };
				editAgentData = null;
			}}
		/>
	{/if}
</Modal>

<style>
	:global(html, body) {
		margin: 0;
		height: 100%;
		overflow: hidden;
		font-family: ui-sans-serif, system-ui, sans-serif;
		background: #0e0e10;
		color: #e8e8ea;
	}
	.root {
		display: grid;
		grid-template-columns: 240px 1fr;
		height: 100vh;
		width: 100vw;
		overflow: hidden;
	}
	aside {
		background: #16161a;
		border-right: 1px solid #2a2a30;
		padding: 0.75rem;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.brand {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.4rem;
		margin-bottom: 0.75rem;
	}
	.brand-img {
		/* Decorative atmosphere asset; the wordmark below carries
		 * the actual brand name. Stays a fixed display size; the
		 * source is exported at 2× so it stays crisp on retina. */
		width: 140px;
		height: 140px;
		border-radius: 6px;
		border: 1px solid #2a2a30;
		display: block;
	}
	.brand-row {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
	}
	.brand h1 {
		margin: 0;
		font-size: 1.1rem;
	}
	.status {
		font-size: 0.85rem;
		color: #555;
	}
	.status.on {
		color: #6ee7b7;
	}
	/* Protocol-viewer nav row: matches the .channel-row visual
	 * weight so the sidebar reads as one consistent list of
	 * navigable items (#90 item 3). */
	.nav-section {
		margin-top: 0;
		margin-bottom: 0.25rem;
	}
	.nav-row {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		color: #cbd5e1;
		text-decoration: none;
		padding: 0.4rem 0.5rem;
		border-radius: 4px;
		font-size: 0.95rem;
		transition: background 120ms;
	}
	.nav-row:hover {
		background: #1f1f24;
		color: #e8e8ea;
	}
	.nav-icon {
		color: #666;
	}

	.section {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		margin-top: 0.5rem;
	}
	.section-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 0.15rem;
	}
	.section-title {
		color: #666;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		font-size: 0.7rem;
	}
	/* Section title rendered as a button so the header is the
	 * collapse-toggle affordance (#90 item 2). Caret shows the
	 * current state. */
	.section-title-btn {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		background: transparent;
		border: 0;
		padding: 0.1rem 0.15rem;
		border-radius: 3px;
		cursor: pointer;
		font: inherit;
		color: inherit;
	}
	.section-title-btn:hover {
		background: #1f1f24;
	}
	.caret {
		color: #555;
		font-size: 0.65rem;
		width: 0.7rem;
		display: inline-block;
	}
	.add-btn {
		background: transparent;
		border: 1px solid #2a2a30;
		color: #94a3b8;
		width: 1.4rem;
		height: 1.4rem;
		line-height: 1;
		font-size: 1rem;
		border-radius: 4px;
		cursor: pointer;
		padding: 0;
	}
	.add-btn:hover {
		background: #1f1f24;
		color: #e8e8ea;
	}
	.row-wrapper {
		position: relative;
		display: flex;
		align-items: center;
	}
	.row-wrapper:hover .row-menu-btn {
		opacity: 1;
	}
	.row-menu-btn {
		opacity: 0;
		background: transparent;
		border: 0;
		color: #777;
		font-size: 1rem;
		padding: 0 0.4rem;
		cursor: pointer;
	}
	.row-menu-btn:hover {
		color: #e8e8ea;
	}
	.menu {
		position: absolute;
		right: 0;
		top: 1.8rem;
		background: #1f1f24;
		border: 1px solid #2a2a30;
		border-radius: 4px;
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5);
		display: flex;
		flex-direction: column;
		min-width: 110px;
		z-index: 10;
	}
	.menu button {
		text-align: left;
		background: transparent;
		border: 0;
		color: #cbd5e1;
		padding: 0.4rem 0.7rem;
		font-family: inherit;
		font-size: 0.85rem;
		cursor: pointer;
	}
	.menu button:hover {
		background: #2a2a30;
	}
	.channel-row {
		flex: 1;
		text-align: left;
		background: transparent;
		color: #cbd5e1;
		border: 0;
		padding: 0.4rem 0.5rem;
		font-family: inherit;
		font-size: 0.95rem;
		border-radius: 4px;
		cursor: pointer;
	}
	.channel-row:hover {
		background: #1f1f24;
	}
	.channel-row.active {
		background: #1f2937;
		color: #f1f5f9;
	}
	.hash {
		color: #555;
		margin-right: 0.25rem;
	}
	.member-row {
		flex: 1;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.3rem 0.5rem;
		font-size: 0.9rem;
		color: #cbd5e1;
	}
	.dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		background: #6ee7b7;
		display: inline-block;
		flex-shrink: 0;
	}
	.dot.disabled {
		background: #555;
	}
	/**
	 * Two-line agent row: name on top, connector type underneath in
	 * a smaller, dimmer style. The previous single-line layout used
	 * `margin-left: auto` to right-align the connector, which wrapped
	 * ugly for the longer types (`anthropic-stub`, `openai-compatible`)
	 * because the row had no width budget left for them.
	 */
	.agent-id {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		line-height: 1.15;
		min-width: 0;
	}
	.agent-name {
		font-size: 0.9rem;
	}
	.connector {
		color: #64748b;
		font-size: 0.7rem;
	}

	.filter-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.2rem 0.5rem;
		font-size: 0.85rem;
		color: #cbd5e1;
		cursor: pointer;
	}
	.filter-row input[type='checkbox'] {
		accent-color: #38bdf8;
	}
	.filter-name {
		flex: 1;
	}

	.main {
		display: flex;
		flex-direction: column;
		min-width: 0;
		height: 100vh;
		overflow: hidden;
	}
	.main header {
		flex: 0 0 auto;
		padding: 0.75rem 1rem;
		border-bottom: 1px solid #2a2a30;
	}
	.channel-header-row {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
	}
	.channel-name {
		/* h1 sized to match settings page's <h1> visual weight
		 * (#90 item 4): symmetric header treatment across the two
		 * surfaces. */
		margin: 0;
		font-size: 1.1rem;
		font-weight: 600;
	}
	.channel-name.muted {
		color: #777;
		font-weight: 400;
	}
	.channel-desc {
		color: #888;
		font-size: 0.85rem;
		margin-top: 0.15rem;
	}
	.channel-actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.search {
		background: #0e0e10;
		border: 1px solid #2a2a30;
		color: #e8e8ea;
		padding: 0.35rem 0.55rem;
		font-family: inherit;
		font-size: 0.85rem;
		border-radius: 4px;
		width: 14rem;
	}
	.export-btn {
		background: #2a2a30;
		color: #e8e8ea;
		border: 1px solid #3a3a42;
		padding: 0.35rem 0.7rem;
		font-family: inherit;
		font-size: 0.85rem;
		border-radius: 4px;
		cursor: pointer;
	}
	.settings-link {
		/* Channel-scoped settings shortcut (ADR-0019). Sits next to
		   Export, opens /settings with the channel pre-selected via
		   URL fragment. Visual matches export-btn so the action bar
		   stays cohesive. */
		background: #2a2a30;
		color: #e8e8ea;
		border: 1px solid #3a3a42;
		padding: 0.35rem 0.6rem;
		font-family: inherit;
		font-size: 0.95rem;
		border-radius: 4px;
		text-decoration: none;
		display: inline-flex;
		align-items: center;
		line-height: 1;
	}
	.settings-link:hover {
		background: #34343c;
	}
	.error {
		background: #3a1a1a;
		color: #fca5a5;
		padding: 0.5rem 1rem;
		font-size: 0.9rem;
	}
	main {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		padding: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.load-older {
		align-self: center;
		background: transparent;
		border: 1px solid #2a2a30;
		color: #94a3b8;
		padding: 0.35rem 0.85rem;
		font-family: inherit;
		font-size: 0.8rem;
		border-radius: 999px;
		cursor: pointer;
	}
	.load-older:hover {
		background: #1f1f24;
		color: #e8e8ea;
	}
	.search-meta {
		color: #94a3b8;
		font-size: 0.8rem;
		font-style: italic;
		text-align: center;
	}
	.search-meta code {
		background: #1f1f24;
		padding: 0.05rem 0.35rem;
		border-radius: 3px;
	}
	footer {
		flex: 0 0 auto;
		display: flex;
		gap: 0.5rem;
		padding: 0.75rem 1rem;
		border-top: 1px solid #2a2a30;
		background: #0e0e10;
	}
	.composer {
		flex: 1;
		position: relative;
	}
	textarea {
		width: 100%;
		box-sizing: border-box;
		/* Subtle distinct background so the input region reads as
		 * its own surface against the chat scroll (#1c1c22 sits one
		 * shade lighter than #16161a). Issue #89. */
		background: #1c1c22;
		border: 1px solid #2a2a30;
		color: #e8e8ea;
		padding: 0.5rem;
		font-family: inherit;
		font-size: 0.95rem;
		border-radius: 4px;
		/* Resize is driven by autosizeComposer() in JS up to the cap.
		 * Disable the manual resize handle to avoid the two interfering. */
		resize: none;
		min-height: 2.5rem;
		overflow-y: hidden;
	}
	textarea:focus {
		outline: none;
		border-color: #475569;
	}
	footer button {
		background: #2a2a30;
		color: #e8e8ea;
		border: 1px solid #3a3a42;
		padding: 0.5rem 1rem;
		font-family: inherit;
		border-radius: 4px;
		cursor: pointer;
	}
	footer button:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
</style>
