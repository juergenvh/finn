<script lang="ts">
	import { onMount, onDestroy, tick } from 'svelte';
	import MessageBubble from '$lib/ui/MessageBubble.svelte';
	import Modal from '$lib/ui/Modal.svelte';
	import ChannelForm from '$lib/ui/ChannelForm.svelte';
	import type { ChannelFormPayload } from '$lib/ui/ChannelForm.svelte';
	import AgentForm from '$lib/ui/AgentForm.svelte';
	import type { AgentFormPayload } from '$lib/ui/AgentForm.svelte';
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
	let activeChannel = $derived(channels.find((c) => c.id === activeChannelId) ?? null);

	let allAgents = $state<AgentInfo[]>([]);
	let members = $state<Record<string, AgentInfo[]>>({});
	let messagesByChannel = $state<Record<string, UIMessage[]>>({});
	let approvalsByMessage = $state<Record<string, ApprovalSnapshot>>({});

	let draft = $state('');
	let bootstrapError: string | null = $state(null);
	let messageScroller: HTMLElement | null = $state(null);

	// Modals
	type ModalState =
		| { kind: 'none' }
		| { kind: 'create_channel' }
		| { kind: 'edit_channel'; channelId: string }
		| { kind: 'create_agent' }
		| { kind: 'edit_agent'; agentId: string };
	let modal = $state<ModalState>({ kind: 'none' });

	// Per-row dropdown menus (sidebar)
	let openMenu = $state<string | null>(null);

	// Loaded agent (for the edit-agent form, fetched on demand)
	let editAgentData = $state<{
		id: string;
		name: string;
		connectorType: 'openclaw' | 'anthropic-stub';
		enabled: boolean;
		config: Record<string, unknown>;
	} | null>(null);

	async function scrollToBottom() {
		await tick();
		if (messageScroller) {
			messageScroller.scrollTop = messageScroller.scrollHeight;
		}
	}

	const visibleMessages = $derived(
		activeChannelId ? messagesByChannel[activeChannelId] ?? [] : []
	);
	const activeMembers = $derived(activeChannelId ? members[activeChannelId] ?? [] : []);

	function nameOfSender(m: UIMessage): string {
		if (m.sender === 'user') return 'you';
		if (m.sender === 'system') return 'system';
		const id = m.senderId;
		if (!id) return 'agent';
		const agent = activeMembers.find((a) => a.id === id) ?? allAgents.find((a) => a.id === id);
		return agent?.name ?? id;
	}

	$effect(() => {
		if (activeChannelId && (messagesByChannel[activeChannelId]?.length ?? 0) >= 0) {
			void scrollToBottom();
		}
	});

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
		if (msg.type === 'state_changed') {
			// Re-fetch the affected slice. Simple and correct.
			if (msg.entity === 'channel') {
				await loadChannels();
				if (msg.action === 'created' && !messagesByChannel[msg.id]) {
					await loadChannelData(msg.id);
				} else if (msg.action === 'deleted' && activeChannelId === msg.id) {
					activeChannelId = channels[0]?.id ?? null;
				}
			} else if (msg.entity === 'agent') {
				await loadAgents();
				// Membership lists may include this agent's metadata
				// (name, enabled). Refresh active channel's members so
				// renamed/disabled agents update visibly.
				if (activeChannelId) await loadChannelData(activeChannelId);
			} else if (msg.entity === 'channel_member') {
				if (messagesByChannel[msg.id] !== undefined) {
					await loadChannelData(msg.id);
				}
			}
			return;
		}
	}

	function send() {
		const body = draft.trim();
		if (!body || !ws || ws.readyState !== WebSocket.OPEN || !activeChannelId) return;
		ws.send(JSON.stringify({ type: 'user_message', channel_id: activeChannelId, body }));
		draft = '';
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

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			send();
		}
	}

	function pickChannel(id: string) {
		activeChannelId = id;
		openMenu = null;
	}

	/* ---------- CRUD actions ---------- */

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
			if (!channelRes.ok) throw new Error((await channelRes.json()).message ?? `HTTP ${channelRes.status}`);

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
		if (!confirm('Archive this agent? It will no longer dispatch; past messages remain attributed.')) return;
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

		<div class="section">
			<div class="section-header">
				<span class="section-title">channels</span>
				<button class="add-btn" title="add channel" onclick={() => (modal = { kind: 'create_channel' })}>+</button>
			</div>
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
		</div>

		<div class="section">
			<div class="section-header">
				<span class="section-title">agents</span>
				<button class="add-btn" title="add agent" onclick={() => (modal = { kind: 'create_agent' })}>+</button>
			</div>
			{#each allAgents as a (a.id)}
				<div class="row-wrapper">
					<div class="member-row">
						<span class="dot" class:disabled={!a.enabled}></span>
						{a.name}
						<span class="connector">{a.connectorType}</span>
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
		</div>

		{#if activeChannelId && activeMembers.length > 0}
			<div class="section">
				<div class="section-title">in this channel</div>
				{#each activeMembers as m (m.id)}
					<div class="member-row compact">
						<span class="dot" class:disabled={!m.enabled}></span>
						{m.name}
					</div>
				{/each}
			</div>
		{/if}
	</aside>

	<section class="main">
		<header>
			{#if activeChannel}
				<div class="channel-name">#{activeChannel.name}</div>
				{#if activeChannel.description}
					<div class="channel-desc">{activeChannel.description}</div>
				{/if}
			{:else}
				<div class="channel-name muted">no channel selected</div>
			{/if}
		</header>

		{#if bootstrapError}
			<div class="error">bootstrap failed: {bootstrapError}</div>
		{/if}

		<main bind:this={messageScroller}>
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

<Modal
	open={modal.kind === 'create_channel'}
	title="Create channel"
	onClose={() => (modal = { kind: 'none' })}
>
	<ChannelForm
		mode="create"
		allAgents={allAgents.filter((a) => !('deletedAt' in a) || (a as any).deletedAt === null)}
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
	.member-row.compact {
		padding: 0.15rem 0.5rem;
		font-size: 0.85rem;
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
		height: 100vh;
		overflow: hidden;
	}
	.main header {
		flex: 0 0 auto;
		padding: 0.75rem 1rem;
		border-bottom: 1px solid #2a2a30;
	}
	.channel-name {
		font-size: 1rem;
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
	footer {
		flex: 0 0 auto;
		display: flex;
		gap: 0.5rem;
		padding: 0.75rem 1rem;
		border-top: 1px solid #2a2a30;
		background: #0e0e10;
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
