<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { renderMarkdown } from '$lib/ui/markdown';

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
	let renderMode = $state<'rendered' | 'raw'>('rendered');
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

	function exportMemory() {
		const qs = buildQueryString();
		const url = `/api/protocol/export?format=memory${qs ? `&${qs}` : ''}`;
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
			<button onclick={exportMemory} disabled={loading} title="Export as agent memory log (memory/YYYY-MM-DD.md format)">Export memory log</button>
		</div>
		<div class="actions">
			<button
				class="toggle-render"
				class:active={renderMode === 'rendered'}
				onclick={() => renderMode = renderMode === 'rendered' ? 'raw' : 'rendered'}
				title="Toggle between rendered markdown and raw source"
			>
				{renderMode === 'rendered' ? '⬡ rendered' : '⬡ raw'}
			</button>
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
				<div
					class="hit"
					class:hidden-row={r.hiddenAt !== null}
					class:sender-user={r.senderType === 'user'}
					class:sender-agent={r.senderType === 'agent'}
				>
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
					{#if renderMode === 'rendered'}
						<div class="hit-body rendered">{@html renderMarkdown(r.body, [])}</div>
					{:else}
						<div class="hit-body raw">{r.body}</div>
					{/if}
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
	}
	.root {
		display: grid;
		grid-template-columns: 280px 1fr;
		height: 100vh;
		width: 100vw;
		overflow: hidden;
	}
	aside {
		background: var(--finn-bg-elevated);
		border-right: 1px solid var(--finn-border);
		padding: var(--finn-space-4);
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
		color: var(--finn-text-secondary);
		text-decoration: none;
		font-size: var(--finn-text-sm);
	}
	.back:hover {
		color: var(--finn-text-primary);
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
		font-size: var(--finn-text-xs);
		color: var(--finn-text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.06em;
		font-weight: 500;
	}
	.check-list {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		max-height: 9rem;
		overflow-y: auto;
		border: 1px solid var(--finn-border);
		border-radius: var(--finn-radius-sm);
		padding: 0.3rem 0.4rem;
		background: var(--finn-bg-input);
	}
	.check-row {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: var(--finn-text-sm);
		color: var(--finn-text-secondary);
		cursor: pointer;
	}
	.meta {
		color: var(--finn-text-muted);
		font-size: var(--finn-text-xs);
		margin-left: auto;
	}
	.hint {
		color: var(--finn-text-muted);
		font-size: var(--finn-text-xs);
	}
	.empty {
		color: var(--finn-text-muted);
		font-style: italic;
		font-size: var(--finn-text-sm);
	}
	input:not([type]),
	input[type='datetime-local'],
	select {
		background: var(--finn-bg-input);
		border: 1px solid var(--finn-border);
		color: var(--finn-text-primary);
		padding: 0.35rem 0.5rem;
		font-family: inherit;
		font-size: var(--finn-text-sm);
		border-radius: var(--finn-radius-sm);
		transition: border-color var(--finn-transition-fast);
	}
	input:focus, select:focus {
		outline: none;
		border-color: var(--finn-accent);
	}
	.actions {
		display: flex;
		gap: 0.5rem;
	}
	.actions button {
		background: var(--finn-bg-surface);
		color: var(--finn-text-secondary);
		border: 1px solid var(--finn-border);
		padding: 0.4rem 0.75rem;
		font-family: inherit;
		font-size: var(--finn-text-sm);
		border-radius: var(--finn-radius-sm);
		cursor: pointer;
		flex: 1;
		transition: background var(--finn-transition-fast);
	}
	.actions button:hover:not(:disabled) {
		background: var(--finn-bg-hover);
	}
	.actions button.primary {
		background: var(--finn-accent);
		border-color: var(--finn-accent);
		color: #fff;
		font-weight: 500;
	}
	.actions button.primary:hover:not(:disabled) {
		background: var(--finn-accent-hover);
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
		padding: 0.75rem var(--finn-space-4);
		border-bottom: 1px solid var(--finn-border);
		background: var(--finn-bg-elevated);
	}
	.result-summary {
		font-size: var(--finn-text-sm);
		color: var(--finn-text-secondary);
	}
	.more {
		color: var(--finn-text-muted);
		font-size: var(--finn-text-sm);
	}
	.error {
		background: var(--finn-error-bg);
		color: var(--finn-error);
		padding: 0.5rem var(--finn-space-4);
		font-size: var(--finn-text-sm);
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
		background: var(--finn-bg-elevated);
		border: 1px solid var(--finn-border);
		border-radius: var(--finn-radius-md);
	}
	/* Two-tone backgrounds to distinguish user from agent messages. */
	.hit.sender-user {
		background: var(--finn-accent-soft);
		border-color: var(--finn-accent-glow);
	}
	.hit.sender-agent {
		background: var(--finn-bg-surface);
	}
	.hit.hidden-row {
		opacity: 0.6;
		border-left: 3px dashed var(--finn-text-disabled);
	}
	.hit-header {
		display: flex;
		align-items: baseline;
		gap: 0.6rem;
		margin-bottom: 0.3rem;
		font-size: 0.8rem;
	}
	.channel-pill {
		background: var(--finn-accent-soft);
		color: var(--finn-accent-hover);
		padding: 0.1rem 0.45rem;
		border-radius: var(--finn-radius-full);
		text-decoration: none;
		font-size: var(--finn-text-xs);
		transition: background var(--finn-transition-fast);
	}
	.channel-pill:hover {
		background: rgba(139, 92, 246, 0.2);
		color: var(--finn-text-primary);
	}
	.sender {
		color: var(--finn-text-primary);
		font-weight: 500;
	}
	.ts {
		color: var(--finn-text-muted);
		font-size: var(--finn-text-xs);
	}
	.hidden-tag {
		margin-left: auto;
		color: var(--finn-text-secondary);
		font-size: var(--finn-text-xs);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.hit-body {
		word-break: break-word;
		font-size: 0.92rem;
	}
	.hit-body.raw {
		white-space: pre-wrap;
		font-family: var(--finn-font-mono);
		font-size: 0.82rem;
		color: var(--finn-text-secondary);
	}
	.hit-body.rendered :global(p) { margin: 0.25rem 0; }
	.hit-body.rendered :global(p:first-child) { margin-top: 0; }
	.hit-body.rendered :global(p:last-child) { margin-bottom: 0; }
	.hit-body.rendered :global(pre) {
		background: var(--finn-bg-elevated);
		border: 1px solid var(--finn-border);
		border-radius: var(--finn-radius-sm);
		padding: 0.5rem 0.75rem;
		overflow-x: auto;
		font-size: 0.82rem;
	}
	.hit-body.rendered :global(code:not(pre code)) {
		background: var(--finn-bg-elevated);
		color: var(--finn-accent-hover);
		border-radius: var(--finn-radius-sm);
		padding: 0.1em 0.3em;
		font-size: 0.85em;
	}
	.hit-body.rendered :global(img) {
		max-width: 100%;
		height: auto;
	}
	.toggle-render {
		font-size: var(--finn-text-xs);
		color: var(--finn-text-muted);
	}
	.toggle-render.active {
		color: var(--finn-accent-hover);
		border-color: var(--finn-accent-glow);
	}
	.empty-result {
		color: var(--finn-text-muted);
		text-align: center;
		font-style: italic;
		padding: 2rem 0;
	}
	.load-more {
		align-self: center;
		background: transparent;
		border: 1px solid var(--finn-border);
		color: var(--finn-text-muted);
		padding: 0.4rem 1rem;
		font-family: inherit;
		font-size: var(--finn-text-sm);
		border-radius: var(--finn-radius-full);
		cursor: pointer;
		margin-top: 1rem;
		transition: background var(--finn-transition-fast), color var(--finn-transition-fast);
	}
	.load-more:hover {
		background: var(--finn-bg-hover);
		color: var(--finn-text-secondary);
	}
	.load-more:disabled {
		opacity: 0.5;
		cursor: wait;
	}
</style>
