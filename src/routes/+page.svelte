<script lang="ts">
	import { onMount, onDestroy } from 'svelte';

	type IncomingMsg =
		| { type: 'message'; channel_id: string; sender: 'user' | 'agent'; body: string; ts: number }
		| { type: 'system'; body: string }
		| { type: 'pong' };

	let ws: WebSocket | null = $state(null);
	let connected = $state(false);
	let messages: Array<{ id: number; sender: 'user' | 'agent' | 'system'; body: string; ts: number }> = $state([]);
	let draft = $state('');
	let nextId = 0;
	const channelId = 'spike';

	function append(sender: 'user' | 'agent' | 'system', body: string, ts = Date.now()) {
		messages = [...messages, { id: nextId++, sender, body, ts }];
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
				append('system', `[unparseable: ${ev.data}]`);
				return;
			}
			if (msg.type === 'message') {
				append(msg.sender, msg.body, msg.ts);
			} else if (msg.type === 'system') {
				append('system', msg.body);
			}
		};
		ws = socket;
	}

	function send() {
		const body = draft.trim();
		if (!body || !ws || ws.readyState !== WebSocket.OPEN) return;
		ws.send(JSON.stringify({ type: 'user_message', channel_id: channelId, body }));
		draft = '';
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			send();
		}
	}

	onMount(() => {
		connect();
	});

	onDestroy(() => {
		ws?.close();
	});
</script>

<div class="root">
	<header>
		<h1>finn</h1>
		<span class="status" class:on={connected}>{connected ? 'connected' : 'disconnected'}</span>
	</header>

	<main>
		{#each messages as m (m.id)}
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
	.status {
		font-size: 0.75rem;
		color: #888;
	}
	.status.on {
		color: #6ee7b7;
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
