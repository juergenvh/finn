<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';

	type ChannelInfo = { id: string; name: string; description: string | null };
	type AgentInfo = { id: string; name: string; connectorType: string; enabled: boolean };

	type Hit = {
		id: string;
		channelId: string;
		channelName: string;
		senderType: 'user' | 'agent' | 'system';
		senderId: string | null;
		senderName: string | null;
		body: string;
		createdAt: number;
		hiddenAt: number | null;
	};

	type VisibilityFilter = 'visible_only' | 'hidden_only' | 'all';

	let channels = $state<ChannelInfo[]>([]);
	let agents = $state<AgentInfo[]>([]);

	/** Current filter state. URL is the source of truth at page-load
	 * time; the user's interactions update both the local state and
	 * the URL so reload / share-link works. */
	let selectedChannels = $state<Set<string>>(new Set());
	let selectedAgents = $state<Set<string>>(new Set());
	let q = $state('');
	let typeUser = $state(true);
	let typeAgent = $state(true);
	let typeSystem = $state(true);
	let fromInput = $state('');
	let toInput = $state('');
	let visibility = $state<VisibilityFilter>('all');
	let onlyRejected = $state(false);

	let rows = $state<Hit[]>([]);
	let nextCursor = $state<string | null>(null);
	let loading = $state(false);
	let errorMsg = $state<string | null>(null);

	function fmtTs(ms: number): string {
		const d = new Date(ms);
		const pad = (n: number) => String(n).padStart(2, '0');
		return (
			`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
			`${pad(d.getHours())}:${pad(d.getMinutes())}`
		);
	}

	function parseDateInput(value: string): number | undefined {
		if (!value) return undefined;
		const d = new Date(value);
		const t = d.getTime();
		return Number.isFinite(t) ? t : undefined;
	}

	function buildQueryString(): string {
		const params = new URLSearchParams();
		if (selectedChannels.size > 0) params.set('channels', [...selectedChannels].join(','));
		if (q.trim()) params.set('q', q.trim());

		const types: string[] = [];
		if (typeUser) types.push('user');
		if (typeAgent) types.push('agent');
		if (typeSystem) types.push('system');
		// Only include if it's a non-trivial subset; all-three or none-true
		// behave the same to the server (no filter), so save bytes.
		if (types.length > 0 && types.length < 3) params.set('sender_types', types.join(','));

		if (selectedAgents.size > 0) params.set('senders', [...selectedAgents].join(','));

		const from = parseDateInput(fromInput);
		const to = parseDateInput(toInput);
		if (from !== undefined) params.set('from', String(from));
		if (to !== undefined) params.set('to', String(to));

		if (visibility !== 'all') params.set('visibility', visibility);
		if (onlyRejected) params.set('only_rejected', '1');

		return params.toString();
	}

	function syncUrl() {
		const qs = buildQueryString();
		const next = qs ? `?${qs}` : window.location.pathname;
		window.history.replaceState(null, '', next);
	}

	function loadFromUrl() {
		const params = new URLSearchParams(page.url.search);
		const channels = params.get('channels');
		if (channels) selectedChannels = new Set(channels.split(',').filter(Boolean));
		const senders = params.get('senders');
		if (senders) selectedAgents = new Set(senders.split(',').filter(Boolean));
		q = params.get('q') ?? '';
		const types = params.get('sender_types');
		if (types) {
			const set = new Set(types.split(','));
			typeUser = set.has('user');
			typeAgent = set.has('agent');
			typeSystem = set.has('system');
		}
		const from = params.get('from');
		if (from) {
			const d = new Date(Number(from));
			fromInput = d.toISOString().slice(0, 16);
		}
		const to = params.get('to');
		if (to) {
			const d = new Date(Number(to));
			toInput = d.toISOString().slice(0, 16);
		}
		const vis = params.get('visibility');
		if (vis === 'visible_only' || vis === 'hidden_only' || vis === 'all') {
			visibility = vis;
		}
		onlyRejected = params.get('only_rejected') === '1';
	}

	async function loadFilters() {
		const [chRes, agRes] = await Promise.all([fetch('/api/channels'), fetch('/api/agents')]);
		if (chRes.ok) channels = ((await chRes.json()) as { channels: ChannelInfo[] }).channels;
		if (agRes.ok) agents = ((await agRes.json()) as { agents: AgentInfo[] }).agents;
	}

	async function runQuery(append = false) {
		loading = true;
		errorMsg = null;
		try {
			const qs = buildQueryString();
			const url = `/api/protocol${qs ? `?${qs}` : ''}${
				append && nextCursor ? `${qs ? '&' : '?'}cursor=${encodeURIComponent(nextCursor)}` : ''
			}`;
			const res = await fetch(url);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as { rows: Hit[]; next_cursor: string | null };
			rows = append ? [...rows, ...data.rows] : data.rows;
			nextCursor = data.next_cursor;
		} catch (err) {
			errorMsg = (err as Error).message;
		} finally {
			loading = false;
		}
	}

	function applyFilters() {
		nextCursor = null;
		syncUrl();
		void runQuery(false);
	}

	function loadMore() {
		void runQuery(true);
	}

	function toggleChannel(id: string) {
		const next = new Set(selectedChannels);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selectedChannels = next;
	}

	function toggleAgent(id: string) {
		const next = new Set(selectedAgents);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selectedAgents = next;
	}

	function clearFilters() {
		selectedChannels = new Set();
		selectedAgents = new Set();
		q = '';
		typeUser = true;
		typeAgent = true;
		typeSystem = true;
		fromInput = '';
		toInput = '';
		visibility = 'all';
		onlyRejected = false;
		applyFilters();
	}

	function exportFiltered() {
		const qs = buildQueryString();
		const url = `/api/protocol/export?format=md${qs ? `&${qs}` : ''}`;
		window.location.href = url;
	}

	onMount(async () => {
		loadFromUrl();
		await loadFilters();
		await runQuery(false);
	});
</script>

<div class="root">
	<aside>
		<div class="brand">
			<a class="back" href="/" title="back to channels">← finn</a>
			<h1>protocol</h1>
		</div>

		<div class="filter-section">
			<span class="lbl">search</span>
			<input bind:value={q} placeholder="substring in message body" />
		</div>

		<div class="filter-section">
			<span class="lbl">channels</span>
			<div class="check-list">
				{#each channels as c (c.id)}
					<label class="check-row">
						<input
							type="checkbox"
							checked={selectedChannels.has(c.id)}
							onchange={() => toggleChannel(c.id)}
						/>
						<span>#{c.name}</span>
					</label>
				{/each}
				{#if channels.length === 0}<span class="empty">no channels</span>{/if}
			</div>
			<span class="hint">empty = all channels</span>
		</div>

		<div class="filter-section">
			<span class="lbl">sender types</span>
			<label class="check-row">
				<input type="checkbox" bind:checked={typeUser} />
				<span>user</span>
			</label>
			<label class="check-row">
				<input type="checkbox" bind:checked={typeAgent} />
				<span>agent</span>
			</label>
			<label class="check-row">
				<input type="checkbox" bind:checked={typeSystem} />
				<span>system</span>
			</label>
		</div>

		<div class="filter-section">
			<span class="lbl">specific agents</span>
			<div class="check-list">
				{#each agents as a (a.id)}
					<label class="check-row">
						<input
							type="checkbox"
							checked={selectedAgents.has(a.id)}
							onchange={() => toggleAgent(a.id)}
						/>
						<span>{a.name}</span>
						<span class="meta">{a.connectorType}</span>
					</label>
				{/each}
			</div>
			<span class="hint">empty = all agents</span>
		</div>

		<div class="filter-section">
			<span class="lbl">date range</span>
			<input type="datetime-local" bind:value={fromInput} />
			<input type="datetime-local" bind:value={toInput} />
		</div>

		<div class="filter-section">
			<span class="lbl">visibility</span>
			<select bind:value={visibility}>
				<option value="all">all (audit default)</option>
				<option value="visible_only">visible only (channel-view)</option>
				<option value="hidden_only">groomed only</option>
			</select>
		</div>

		<div class="filter-section">
			<label class="check-row">
				<input type="checkbox" bind:checked={onlyRejected} />
				<span>only rejected approvals</span>
			</label>
		</div>

		<div class="actions">
			<button class="primary" onclick={applyFilters} disabled={loading}>Apply</button>
			<button onclick={clearFilters} disabled={loading}>Clear</button>
		</div>
		<div class="actions">
			<button onclick={exportFiltered} disabled={loading}>Export markdown</button>
		</div>
	</aside>

	<section class="results">
		<header>
			<div class="result-summary">
				{rows.length} row{rows.length === 1 ? '' : 's'}
				{#if nextCursor}<span class="more"> · more available</span>{/if}
			</div>
		</header>

		{#if errorMsg}
			<div class="error">{errorMsg}</div>
		{/if}

		<main>
			{#each rows as r (r.id)}
				<div class="hit" class:hidden-row={r.hiddenAt !== null}>
					<div class="hit-header">
						<a class="channel-pill" href={`/?channel=${r.channelId}`}>#{r.channelName}</a>
						<span class="sender">
							{r.senderType === 'user'
								? r.senderName ?? 'user'
								: r.senderType === 'agent'
									? r.senderName ?? r.senderId
									: 'system'}
						</span>
						<span class="ts">{fmtTs(r.createdAt)}</span>
						{#if r.hiddenAt !== null}
							<span class="hidden-tag">groomed</span>
						{/if}
					</div>
					<div class="hit-body">{r.body}</div>
				</div>
			{/each}

			{#if rows.length === 0 && !loading}
				<div class="empty-result">no rows match these filters</div>
			{/if}

			{#if nextCursor}
				<button class="load-more" onclick={loadMore} disabled={loading}>
					{loading ? 'loading…' : 'Load more'}
				</button>
			{/if}
		</main>
	</section>
</div>

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
		grid-template-columns: 280px 1fr;
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
		gap: 0.75rem;
	}
	.brand {
		display: flex;
		align-items: baseline;
		gap: 0.6rem;
	}
	.back {
		color: #94a3b8;
		text-decoration: none;
		font-size: 0.85rem;
	}
	.back:hover {
		color: #e8e8ea;
	}
	.brand h1 {
		margin: 0;
		font-size: 1rem;
		font-weight: 600;
	}
	.filter-section {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	.lbl {
		font-size: 0.7rem;
		color: #94a3b8;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.check-list {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		max-height: 9rem;
		overflow-y: auto;
		border: 1px solid #2a2a30;
		border-radius: 4px;
		padding: 0.3rem 0.4rem;
		background: #0e0e10;
	}
	.check-row {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.85rem;
		color: #cbd5e1;
		cursor: pointer;
	}
	.meta {
		color: #64748b;
		font-size: 0.7rem;
		margin-left: auto;
	}
	.hint {
		color: #64748b;
		font-size: 0.72rem;
	}
	.empty {
		color: #64748b;
		font-style: italic;
		font-size: 0.8rem;
	}
	input:not([type]),
	input[type='datetime-local'],
	select {
		background: #0e0e10;
		border: 1px solid #2a2a30;
		color: #e8e8ea;
		padding: 0.35rem 0.5rem;
		font-family: inherit;
		font-size: 0.85rem;
		border-radius: 4px;
	}
	.actions {
		display: flex;
		gap: 0.5rem;
	}
	.actions button {
		background: #2a2a30;
		color: #e8e8ea;
		border: 1px solid #3a3a42;
		padding: 0.4rem 0.75rem;
		font-family: inherit;
		font-size: 0.85rem;
		border-radius: 4px;
		cursor: pointer;
		flex: 1;
	}
	.actions button.primary {
		background: #075985;
		border-color: #0284c7;
	}
	.actions button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.results {
		display: flex;
		flex-direction: column;
		min-width: 0;
		height: 100vh;
		overflow: hidden;
	}
	.results header {
		flex: 0 0 auto;
		padding: 0.75rem 1rem;
		border-bottom: 1px solid #2a2a30;
	}
	.result-summary {
		font-size: 0.9rem;
		color: #cbd5e1;
	}
	.more {
		color: #64748b;
		font-size: 0.8rem;
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
		padding: 0.75rem 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
	}
	.hit {
		padding: 0.5rem 0.75rem;
		background: #16161a;
		border: 1px solid #2a2a30;
		border-radius: 6px;
	}
	.hit.hidden-row {
		opacity: 0.6;
		border-left: 3px dashed #475569;
	}
	.hit-header {
		display: flex;
		align-items: baseline;
		gap: 0.6rem;
		margin-bottom: 0.3rem;
		font-size: 0.8rem;
	}
	.channel-pill {
		background: #1e3a5f;
		color: #cbd5e1;
		padding: 0.1rem 0.45rem;
		border-radius: 9999px;
		text-decoration: none;
		font-size: 0.75rem;
	}
	.channel-pill:hover {
		background: #1f4b78;
		color: #f1f5f9;
	}
	.sender {
		color: #e2e8f0;
		font-weight: 500;
	}
	.ts {
		color: #64748b;
		font-size: 0.75rem;
	}
	.hidden-tag {
		margin-left: auto;
		color: #94a3b8;
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.hit-body {
		white-space: pre-wrap;
		word-break: break-word;
		font-size: 0.92rem;
	}
	.empty-result {
		color: #64748b;
		text-align: center;
		font-style: italic;
		padding: 2rem 0;
	}
	.load-more {
		align-self: center;
		background: transparent;
		border: 1px solid #2a2a30;
		color: #94a3b8;
		padding: 0.4rem 1rem;
		font-family: inherit;
		font-size: 0.85rem;
		border-radius: 999px;
		cursor: pointer;
		margin-top: 1rem;
	}
	.load-more:hover {
		background: #1f1f24;
		color: #e8e8ea;
	}
	.load-more:disabled {
		opacity: 0.5;
		cursor: wait;
	}
</style>
