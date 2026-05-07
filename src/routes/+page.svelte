<script lang="ts">
	import { onMount, onDestroy } from 'svelte';

	type ChannelInfo = { id: string; name: string; description: string | null };

	type DBMessage = {
		id: string;
		channelId: string;
		senderType: 'user' | 'agent' | 'system';
		senderId: string | null;
		body: string;
		createdAt: number;
	};

	type IncomingMsg =
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

	type UIMessage = {
		key: string;
		sender: 'user' | 'agent' | 'system';
		body: string;
		ts: number;
	};

	let ws: WebSocket | null = $state(null);
	let connected = $state(false);
	let channel: ChannelInfo | null = $state(null);
	let messages: UIMessage[] = $state([]);
	let draft = $state('');
	let bootstrapError: string | null = $state(null);
	let scratchKey = 0;

	function append(sender: 'user' | 'agent' | 'system', body: string, ts: number, key?: string) {
		messages = [...messages, { key: key ?? `local-${++scratchKey}`, sender, body, ts }];
	}

	async function bootstrap() {
		try {
			const res = await fetch('/api/channels');
			if (!res.ok) throw new Error(`/api/channels ${res.status}`);
			const data = (await res.json()) as { channels: ChannelInfo[] };
			if (data.channels.length === 0) {
				bootstrapError = 'no channels in DB; run `npm run db:seed`';
				return;
			}
			channel = data.channels[0]!;

			const histRes = await fetch(`/api/channels/${channel.id}/messages`);
			if (histRes.ok) {
				const hist = (await histRes.json()) as { messages: DBMessage[] };
				messages = hist.messages.map((m) => ({
					key: m.id,
					sender: m.senderType,
					body: m.body,
					ts: m.createdAt
				}));
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
			let msg: IncomingMsg;
			try {
				msg = JSON.parse(ev.data);
			} catch {
				append('system', `[unparseable: ${ev.data}]`, Date.now());
				return;
			}
			if (msg.type === 'message') {
				if (!channel || msg.channel_id !== channel.id) return;
				append(msg.sender, msg.body, msg.ts, msg.id);
			} else if (msg.type === 'system') {
				append('system', msg.body, Date.now());
			}
		};
		ws = socket;
	}

	function send() {
		const body = draft.trim();
		if (!body || !ws || ws.readyState !== WebSocket.OPEN || !channel) return;
		ws.send(JSON.stringify({ type: 'user_message', channel_id: channel.id, body }));
		draft = '';
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			send();
		}
	}

	onMount(() => {
		bootstrap();
	});

	onDestroy(() => {
		ws?.close();
	});
</script>

<div class="root">
	<header>
		<h1>finn</h1>
		{#if channel}
			<span class="channel">#{channel.name}</span>
		{/if}
		<span class="status" class:on={connected}>{connected ? 'connected' : 'disconnected'}</span>
	</header>

	{#if bootstrapError}
		<div class="error">bootstrap failed: {bootstrapError}</div>
	{/if}

	<main>
		{#each messages as m (m.key)}
			<div class="msg {m.sender}">
				<span class="who">{m.sender}</span>
				<span class="body">{m.body}</span>
			</div>
		{/each}
	</main>

	<footer>
		<textarea
			bind:value={draft}
			onkeydown={onKey}
			placeholder="message (Enter to send, Shift+Enter for newline)"
			rows="2"
			disabled={!connected}
		></textarea>
		<button onclick={send} disabled={!connected || !draft.trim()}>send</button>
	</footer>
</div>

<style>
	:global(body) {
		margin: 0;
		font-family: ui-sans-serif, system-ui, sans-serif;
		background: #0e0e10;
		color: #e8e8ea;
	}
	.root {
		display: flex;
		flex-direction: column;
		height: 100vh;
		max-width: 900px;
		margin: 0 auto;
	}
	header {
		display: flex;
		align-items: baseline;
		gap: 1rem;
		padding: 0.75rem 1rem;
		border-bottom: 1px solid #2a2a30;
	}
	header h1 {
		margin: 0;
		font-size: 1.1rem;
		font-weight: 600;
	}
	.channel {
		color: #aaa;
		font-size: 0.95rem;
	}
	.status {
		font-size: 0.75rem;
		color: #888;
		margin-left: auto;
	}
	.status.on {
		color: #6ee7b7;
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
	.msg {
		display: grid;
		grid-template-columns: 80px 1fr;
		gap: 0.75rem;
		padding: 0.4rem 0.6rem;
		border-radius: 4px;
	}
	.msg.user {
		background: #1a2030;
	}
	.msg.agent {
		background: #1a2a1f;
	}
	.msg.system {
		background: transparent;
		color: #777;
		font-style: italic;
		font-size: 0.85rem;
	}
	.who {
		color: #888;
		font-size: 0.8rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}
	.body {
		white-space: pre-wrap;
		word-break: break-word;
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
	button {
		background: #2a2a30;
		color: #e8e8ea;
		border: 1px solid #3a3a42;
		padding: 0.5rem 1rem;
		font-family: inherit;
		border-radius: 4px;
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
</style>
