<!--
  Settings surface (ADR-0019).

  This is the PR-1 skeleton: read-only display of global + per-channel
  settings, with a left rail that lets the user switch between the
  global pane and per-channel detail. No editing yet — PR 2 adds the
  PATCH endpoints and wires inputs.

  Layout:
    - Left rail: "Global" entry plus one entry per channel.
    - Main pane: the values for the currently-selected scope, with
      effective-value annotations where channel overrides apply.

  The route is deliberately minimal CSS-wise; the styling pass lands
  with the editable controls in PR 2 so we don't paint twice.
-->
<script lang="ts">
	import { onMount } from 'svelte';

	type Theme = 'system' | 'light' | 'dark';

	type Global = {
		kbBudgetDefault: number;
		showGroomedDefault: boolean;
		hideSystemMessagesDefault: boolean;
		defaultChannelId: string | null;
		theme: Theme;
	};

	type ChannelSettings = {
		channelId: string;
		kbBudgetOverride: number | null;
		autoApprove: boolean;
		effective: { kbBudget: number; autoApprove: boolean };
	};

	type ChannelInfo = { id: string; name: string };

	let channels = $state<ChannelInfo[]>([]);
	let global = $state<Global | null>(null);
	let selected = $state<string>('global'); // 'global' | channelId
	let channelDetail = $state<ChannelSettings | null>(null);
	let loadError = $state<string | null>(null);

	async function loadGlobal() {
		const res = await fetch('/api/settings');
		if (!res.ok) {
			loadError = `Failed to load global settings: ${res.status}`;
			return;
		}
		const data = await res.json();
		global = data.global as Global;
	}

	async function loadChannels() {
		const res = await fetch('/api/channels');
		if (!res.ok) return;
		const data = await res.json();
		channels = (data.channels as ChannelInfo[]).slice().sort((a, b) => a.name.localeCompare(b.name));
	}

	async function loadChannelDetail(channelId: string) {
		channelDetail = null;
		const res = await fetch(`/api/settings?channelId=${encodeURIComponent(channelId)}`);
		if (!res.ok) {
			loadError = `Failed to load channel settings: ${res.status}`;
			return;
		}
		const data = await res.json();
		channelDetail = data.channel as ChannelSettings;
	}

	$effect(() => {
		if (selected === 'global') {
			channelDetail = null;
		} else if (selected) {
			loadChannelDetail(selected);
		}
	});

	onMount(async () => {
		await Promise.all([loadGlobal(), loadChannels()]);
	});

	function channelName(id: string): string {
		return channels.find((c) => c.id === id)?.name ?? id;
	}
</script>

<svelte:head>
	<title>Settings — finn</title>
</svelte:head>

<div class="settings-page">
	<aside class="rail">
		<h2>Settings</h2>
		<nav>
			<button
				type="button"
				class:active={selected === 'global'}
				onclick={() => (selected = 'global')}
			>
				Global
			</button>
			<div class="rail-divider">Channels</div>
			{#each channels as ch (ch.id)}
				<button
					type="button"
					class:active={selected === ch.id}
					onclick={() => (selected = ch.id)}
				>
					{ch.name}
				</button>
			{:else}
				<div class="rail-empty">No channels yet.</div>
			{/each}
		</nav>
		<p class="rail-foot">
			<a href="/">← back to channels</a>
		</p>
	</aside>

	<main class="pane">
		{#if loadError}
			<p class="error">{loadError}</p>
		{/if}

		{#if selected === 'global'}
			<h1>Global settings</h1>
			<p class="note">
				These values are the default for every channel. Per-channel overrides win when set.
				Editing lands in the next PR; this view is read-only.
			</p>
			{#if global}
				<dl>
					<dt>Initial-load KB budget</dt>
					<dd>{global.kbBudgetDefault} KB</dd>

					<dt>Show groomed messages by default</dt>
					<dd>{global.showGroomedDefault ? 'yes' : 'no'}</dd>

					<dt>Hide system messages by default</dt>
					<dd>{global.hideSystemMessagesDefault ? 'yes' : 'no'}</dd>

					<dt>Default channel on open</dt>
					<dd>
						{global.defaultChannelId
							? channelName(global.defaultChannelId)
							: '— (last-active)'}
					</dd>

					<dt>Theme</dt>
					<dd>{global.theme}</dd>
				</dl>
			{:else if !loadError}
				<p>Loading…</p>
			{/if}
		{:else}
			<h1>Channel: {channelName(selected)}</h1>
			<p class="note">
				Per-channel overrides for <strong>{channelName(selected)}</strong>. Empty values
				inherit the global default.
			</p>
			{#if channelDetail && global}
				<dl>
					<dt>KB budget</dt>
					<dd>
						{#if channelDetail.kbBudgetOverride !== null}
							{channelDetail.kbBudgetOverride} KB
							<span class="annotation"
								>(override — global is {global.kbBudgetDefault} KB)</span
							>
						{:else}
							{global.kbBudgetDefault} KB
							<span class="annotation">(inherited from global)</span>
						{/if}
					</dd>

					<dt>Auto-approve agent-to-agent mentions</dt>
					<dd>
						{channelDetail.autoApprove ? 'yes' : 'no'}
						<span class="annotation"
							>(per-channel only — global default is "no")</span
						>
					</dd>
				</dl>
			{:else if !loadError}
				<p>Loading…</p>
			{/if}
		{/if}
	</main>
</div>

<style>
	.settings-page {
		display: grid;
		grid-template-columns: 240px 1fr;
		min-height: 100vh;
		font-family: system-ui, sans-serif;
	}

	.rail {
		border-right: 1px solid #e0e0e0;
		padding: 16px;
		background: #fafafa;
	}

	.rail h2 {
		margin: 0 0 12px 0;
		font-size: 1rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: #666;
	}

	.rail nav {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.rail button {
		text-align: left;
		background: transparent;
		border: 0;
		padding: 6px 10px;
		border-radius: 4px;
		cursor: pointer;
		font: inherit;
		color: inherit;
	}

	.rail button:hover {
		background: #eee;
	}

	.rail button.active {
		background: #ddd;
		font-weight: 600;
	}

	.rail-divider {
		margin-top: 12px;
		padding: 4px 10px;
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: #888;
	}

	.rail-empty {
		padding: 6px 10px;
		color: #999;
		font-style: italic;
		font-size: 0.9rem;
	}

	.rail-foot {
		margin-top: 24px;
		font-size: 0.85rem;
	}

	.pane {
		padding: 24px 32px;
	}

	.pane h1 {
		margin-top: 0;
	}

	.note {
		color: #555;
		font-size: 0.9rem;
		max-width: 60ch;
	}

	dl {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 8px 24px;
		margin-top: 24px;
	}

	dt {
		font-weight: 600;
		color: #333;
	}

	dd {
		margin: 0;
	}

	.annotation {
		margin-left: 8px;
		font-size: 0.85rem;
		color: #888;
	}

	.error {
		color: #b00020;
		background: #fdecea;
		padding: 8px 12px;
		border-radius: 4px;
	}
</style>
