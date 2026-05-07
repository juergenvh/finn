<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import MessageBubble from '$lib/ui/MessageBubble.svelte';
	import type {
		ChannelInfo,
		AgentInfo,
		DBMessage,
		ApprovalSnapshot,
		WSInbound
	} from '$lib/ui/types';

	type UIMessage = {
		id: string;
		channelId: string;
		sender: 'user' | 'agent' | 'system';
		senderId: string | null;
		body: string;
		ts: number;
	};

	let ws: WebSocket | null = $state(null);
	let connected = $state(false);

	let channels = $state<ChannelInfo[]>([]);
	let activeChannelId = $state<string | null>(null);
	let activeChannel = $derived(
		channels.find((c) => c.id === activeChannelId) ?? null
	);

	let members = $state<Record<string, AgentInfo[]>>({});
	let messagesByChannel = $state<Record<string, UIMessage[]>>({});
	let approvalsByMessage = $state<Record<string, ApprovalSnapshot>>({});

	let draft = $state('');
	let bootstrapError: string | null = $state(null);

	const visibleMessages = $derived(
		activeChannelId ? messagesByChannel[activeChannelId] ?? [] : []
	);
	const activeMembers = $derived(
		activeChannelId ? members[activeChannelId] ?? [] : []
	);

	function nameOfSender(m: UIMessage): string {
		if (m.sender === 'user') return 'you';
		if (m.sender === 'system') return 'system';
		const id = m.senderId;
		if (!id) return 'agent';
		const agent = activeMembers.find((a) => a.id === id);
		return agent?.name ?? id;
	}

	async function loadChannelData(channelId: string) {
		const [msgRes, memRes, apprRes] = await Promise.all([
			fetch(`/api/channels/${channelId}/messages`),
			fetch(`/api/channels/${channelId}/members`),
			fetch(`/api/channels/${channelId}/approvals`)
		]);
		if (!msgRes.ok || !memRes.ok || !apprRes.ok) {
			throw new Error(
				`channel ${channelId} fetch failed: ${msgRes.status}/${memRes.status}/${apprRes.status}`
			);
		}
		const msgData = (await msgRes.json()) as { messages: DBMessage[] };
		const memData = (await memRes.json()) as { members: AgentInfo[] };
		const apprData = (await apprRes.json()) as { approvals: ApprovalSnapshot[] };

		messagesByChannel = {
			...messagesByChannel,
			[channelId]: msgData.messages.map((m) => ({
				id: m.id,
				channelId: m.channelId,
				sender: m.senderType,
				senderId: m.senderId,
				body: m.body,
				ts: m.createdAt
			}))
		};
		members = { ...members, [channelId]: memData.members };
		const next = { ...approvalsByMessage };
		for (const a of apprData.approvals) next[a.messageId] = a;
		approvalsByMessage = next;
	}

	async function bootstrap() {
		try {
			const res = await fetch('/api/channels');
			if (!res.ok) throw new Error(`/api/channels ${res.status}`);
			const data = (await res.json()) as { channels: ChannelInfo[] };
			channels = data.channels;
			if (channels.length === 0) {
				bootstrapError = 'no channels in DB; run `npm run db:seed`';
				return;
			}
			activeChannelId = channels[0]!.id;
			await Promise.all(channels.map((c) => loadChannelData(c.id)));
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
			handleWsMessage(msg);
		};
		ws = socket;
	}

	function handleWsMessage(msg: WSInbound) {
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
						ts: msg.ts
					}
				]
			};
			return;
		}
		if (msg.type === 'approval_created' || msg.type === 'approval_updated') {
			approvalsByMessage = {
				...approvalsByMessage,
				[msg.approval.messageId]: msg.approval
			};
			return;
		}
	}

	function send() {
		const body = draft.trim();
		if (!body || !ws || ws.readyState !== WebSocket.OPEN || !activeChannelId) return;
		ws.send(JSON.stringify({ type: 'user_message', channel_id: activeChannelId, body }));
		draft = '';
	}

	function decideApproval(approvalId: string, decision: 'approve' | 'reject', targets: string[], reason: string) {
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

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			send();
		}
	}

	function pickChannel(id: string) {
		activeChannelId = id;
	}

	onMount(() => {
		bootstrap();
	});

	onDestroy(() => {
		ws?.close();
	});
</script>

<div class="root">
	<aside>
		<div class="brand">
			<h1>finn</h1>
			<span class="status" class:on={connected}>{connected ? '●' : '○'}</span>
		</div>
		<div class="section-title">channels</div>
		{#each channels as c (c.id)}
			<button class="channel-row" class:active={c.id === activeChannelId} onclick={() => pickChannel(c.id)}>
				<span class="hash">#</span>{c.name}
			</button>
		{/each}
		{#if activeChannelId}
			<div class="section-title">members</div>
			{#each activeMembers as m (m.id)}
				<div class="member-row">
					<span class="dot" class:disabled={!m.enabled}></span>
					{m.name}
					<span class="connector">{m.connectorType}</span>
				</div>
			{/each}
		{/if}
	</aside>

	<section class="main">
		<header>
			{#if activeChannel}
				<div class="channel-name">#{activeChannel.name}</div>
				{#if activeChannel.description}
					<div class="channel-desc">{activeChannel.description}</div>
				{/if}
			{/if}
		</header>

		{#if bootstrapError}
			<div class="error">bootstrap failed: {bootstrapError}</div>
		{/if}

		<main>
			{#each visibleMessages as m (m.id)}
				<MessageBubble
					sender={m.sender}
					senderName={nameOfSender(m)}
					body={m.body}
					ts={m.ts}
					approval={approvalsByMessage[m.id]}
					members={activeMembers}
					excludeAgentIds={m.senderId ? [m.senderId] : []}
					onDecide={(decision, targets, reason) => {
						const approval = approvalsByMessage[m.id];
						if (!approval) return;
						decideApproval(approval.id, decision, targets, reason);
					}}
				/>
			{/each}
		</main>

		<footer>
			<textarea
				bind:value={draft}
				onkeydown={onKey}
				placeholder="message — Enter to send, @-mentions become approval defaults"
				rows="2"
				disabled={!connected || !activeChannelId}
			></textarea>
			<button onclick={send} disabled={!connected || !draft.trim() || !activeChannelId}>send</button>
		</footer>
	</section>
</div>

<style>
	:global(body) {
		margin: 0;
		font-family: ui-sans-serif, system-ui, sans-serif;
		background: #0e0e10;
		color: #e8e8ea;
	}
	.root {
		display: grid;
		grid-template-columns: 240px 1fr;
		height: 100vh;
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
		align-items: baseline;
		gap: 0.5rem;
		margin-bottom: 0.5rem;
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
	.section-title {
		margin-top: 0.75rem;
		margin-bottom: 0.25rem;
		color: #666;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		font-size: 0.7rem;
	}
	.channel-row {
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
	}
	.dot.disabled {
		background: #555;
	}
	.connector {
		color: #555;
		font-size: 0.75rem;
		margin-left: auto;
	}

	.main {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.main header {
		padding: 0.75rem 1rem;
		border-bottom: 1px solid #2a2a30;
	}
	.channel-name {
		font-size: 1rem;
		font-weight: 600;
	}
	.channel-desc {
		color: #888;
		font-size: 0.85rem;
		margin-top: 0.15rem;
	}
	.error {
		background: #3a1a1a;
		color: #fca5a5;
		padding: 0.5rem 1rem;
		font-size: 0.9rem;
	}
	main {
		flex: 1;
		overflow-y: auto;
		padding: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	footer {
		display: flex;
		gap: 0.5rem;
		padding: 0.75rem 1rem;
		border-top: 1px solid #2a2a30;
	}
	textarea {
		flex: 1;
		background: #16161a;
		border: 1px solid #2a2a30;
		color: #e8e8ea;
		padding: 0.5rem;
		font-family: inherit;
		font-size: 0.95rem;
		border-radius: 4px;
		resize: vertical;
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
