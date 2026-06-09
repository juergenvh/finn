<!--
  Settings surface (ADR-0019, PR 3).

  Editable surface for global + per-channel settings. Reads via
  GET /api/settings, writes via PATCH /api/settings and
  PATCH /api/settings/channel/<id>. Stays fresh through the
  state_changed WebSocket broadcasts that the PATCH handlers emit.

  Writes use a small dirty-flag + Save-button pattern rather than
  on-blur autosave. The user explicitly commits; the saved state
  reflects back via the WS broadcast (which is also what every
  other open tab sees).
-->
<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import AgentForm from '$lib/ui/AgentForm.svelte';
	import type { AgentFormPayload } from '$lib/ui/AgentForm.svelte';

	type Theme = 'system' | 'light' | 'dark';

	type AgentInfo = {
		id: string;
		name: string;
		connectorType: string;
		enabled: boolean;
		config?: Record<string, unknown>;
	};

	type Global = {
		kbBudgetDefault: number;
		showGroomedDefault: boolean;
		hideSystemMessagesDefault: boolean;
		defaultChannelId: string | null;
		theme: Theme;
		roundtripCapDefault: number;
	};

	type ChannelSettings = {
		channelId: string;
		kbBudgetOverride: number | null;
		autoApprove: boolean;
		roundtripCapOverride: number | null;
		effective: { kbBudget: number; autoApprove: boolean; roundtripCap: number };
	};

	type ChannelInfo = { id: string; name: string };

	type WSStateChanged = {
		type: 'state_changed';
		entity: 'settings' | 'channel' | 'agent' | 'channel_member' | 'message';
		action: 'created' | 'updated' | 'deleted';
		id: string;
	};

	let channels = $state<ChannelInfo[]>([]);
	let global = $state<Global | null>(null);
	let selected = $state<string>('global'); // 'global' | channelId | 'agents'

	// ── Agent management state ──────────────────────────────────────
	const AGENT_EXPORT_SCHEMA = 'finn-agent-export-v1';
	let agentsList = $state<AgentInfo[]>([]);
	let agentsLoading = $state(false);
	let agentFormMode = $state<'none' | 'create' | 'edit'>('none');
	let editingAgent = $state<AgentInfo | null>(null);
	let loadAgentInput: HTMLInputElement | null = $state(null);
	// channel membership per agent: agentId → array of {id, name}
	let agentChannels = $state<Record<string, { id: string; name: string }[]>>({}); 
	let channelDetail = $state<ChannelSettings | null>(null);
	let loadError = $state<string | null>(null);
	let saveError = $state<string | null>(null);
	let savingGlobal = $state(false);
	let savingChannel = $state(false);

	// Editable buffers. We do NOT bind directly to `global` / `channelDetail`
	// because the WS broadcast reload would clobber unsaved edits. The
	// buffers are seeded on load and on "discard"; Save flushes them.
	let editGlobal = $state<Global | null>(null);
	let editChannel = $state<{
		kbBudgetOverride: number | null;
		autoApprove: boolean;
		roundtripCapOverride: number | null;
	} | null>(null);
	// Channel `kbBudgetOverride` UX: textbox bound to a string so the user
	// can type and clear freely. Empty string = "inherit global" (null on
	// the wire). Numeric out-of-range surfaces as validation on Save.
	let editChannelBudgetText = $state<string>('');
	// Same UX for the roundtrip-cap override.
	let editChannelRoundtripText = $state<string>('');

	let ws: WebSocket | null = null;

	// $derived (not a plain function) so the Save / Discard buttons
	// re-evaluate when editGlobal / editChannel mutate. Plain function
	// calls in attribute position are not reactivity boundaries in
	// Svelte 5 with runes — they're evaluated once per render and the
	// render is not retriggered by inner-state changes.
	function parseNullableInt(text: string, fallback: number | null): number | null {
		const t = text.trim();
		if (t === '') return null;
		const n = Number(t);
		return Number.isFinite(n) ? n : fallback;
	}

	let dirtyGlobal = $derived.by(() => {
		if (!global || !editGlobal) return false;
		// Coerce numeric fields with Number(...) so a string-shaped bind
		// value (Svelte 5 inputs occasionally emit string for numeric
		// inputs depending on bind resolution) still compares correctly
		// against the number snapshot. Without this, "250" !== 200 keeps
		// the form dirty forever even after Save — and the wire payload
		// fails zod validation.
		return (
			Number(editGlobal.kbBudgetDefault) !== Number(global.kbBudgetDefault) ||
			editGlobal.showGroomedDefault !== global.showGroomedDefault ||
			editGlobal.hideSystemMessagesDefault !== global.hideSystemMessagesDefault ||
			editGlobal.defaultChannelId !== global.defaultChannelId ||
			editGlobal.theme !== global.theme ||
			Number(editGlobal.roundtripCapDefault) !== Number(global.roundtripCapDefault)
		);
	});

	let dirtyChannel = $derived.by(() => {
		if (!channelDetail || !editChannel) return false;
		const editBudget = parseNullableInt(editChannelBudgetText, editChannel.kbBudgetOverride);
		const editRoundtrip = parseNullableInt(
			editChannelRoundtripText,
			editChannel.roundtripCapOverride
		);
		return (
			editBudget !== channelDetail.kbBudgetOverride ||
			editRoundtrip !== channelDetail.roundtripCapOverride ||
			editChannel.autoApprove !== channelDetail.autoApprove
		);
	});

	async function loadGlobal() {
		const res = await fetch('/api/settings');
		if (!res.ok) {
			loadError = `Failed to load global settings: ${res.status}`;
			return;
		}
		const data = await res.json();
		global = data.global as Global;
		editGlobal = { ...global };
	}

	async function loadChannels() {
		const res = await fetch('/api/channels');
		if (!res.ok) return;
		const data = await res.json();
		// Server sorts by name (GET /api/channels, issue #92); no
		// client-side re-sort needed.
		channels = data.channels as ChannelInfo[];
	}

	async function loadAgents() {
		agentsLoading = true;
		try {
			const res = await fetch('/api/agents?include_archived=0');
			if (!res.ok) return;
			const data = await res.json();
			agentsList = data.agents as AgentInfo[];
		} finally {
			agentsLoading = false;
		}
	}

	async function submitAgentForm(payload: AgentFormPayload) {
		if (payload.mode === 'create') {
			const res = await fetch('/api/agents', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name: payload.name, enabled: payload.enabled, config: payload.config })
			});
			if (!res.ok) throw new Error((await res.json()).message ?? `HTTP ${res.status}`);
		} else {
			if (!editingAgent) return;
			const res = await fetch(`/api/agents/${editingAgent.id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name: payload.name, enabled: payload.enabled, config: payload.config })
			});
			if (!res.ok) throw new Error((await res.json()).message ?? `HTTP ${res.status}`);
		}
		agentFormMode = 'none';
		editingAgent = null;
		await loadAgents();
	}

	async function openEditAgent(agent: AgentInfo) {
		// Fetch full config from the single-agent endpoint before opening the form
		const res = await fetch(`/api/agents/${agent.id}`);
		if (!res.ok) return;
		const data = await res.json();
		editingAgent = { ...agent, config: data.config ?? {} };
		agentFormMode = 'edit';
	}

	async function archiveAgent(agent: AgentInfo) {
		if (!confirm(`Archive agent "${agent.name}"? It will no longer dispatch; past messages remain attributed.`)) return;
		const res = await fetch(`/api/agents/${agent.id}`, { method: 'DELETE' });
		if (res.ok) await loadAgents();
	}

	async function toggleAgentEnabled(agent: AgentInfo) {
		const res = await fetch(`/api/agents/${agent.id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ enabled: !agent.enabled })
		});
		if (res.ok) await loadAgents();
	}

	async function saveAgentToFile(agent: AgentInfo) {
		try {
			const res = await fetch(`/api/agents/${agent.id}`);
			if (!res.ok) { alert(`failed: ${res.status}`); return; }
			const row = await res.json();
			const envelope = {
				schema: AGENT_EXPORT_SCHEMA,
				exportedAt: new Date().toISOString(),
				agent: { name: row.name, connectorType: row.connectorType, config: row.config }
			};
			const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url; a.download = `finn-agent-${row.name}.json`;
			document.body.appendChild(a); a.click();
			document.body.removeChild(a); URL.revokeObjectURL(url);
		} catch (err) { alert(`export failed: ${(err as Error).message}`); }
	}

	function triggerLoadAgent() { loadAgentInput?.click(); }

	async function onLoadAgentFile(ev: Event) {
		const input = ev.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		try {
			const parsed = JSON.parse(await file.text());
			if (parsed?.schema !== AGENT_EXPORT_SCHEMA) {
				alert(`unrecognised file (expected schema: ${AGENT_EXPORT_SCHEMA})`);
				return;
			}
			const a = parsed.agent;
			if (!a?.name || !a?.connectorType || !a?.config) {
				alert('file missing required fields (name, connectorType, config)');
				return;
			}
			const res = await fetch('/api/agents', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name: a.name, config: a.config, enabled: true })
			});
			if (!res.ok) { alert(`import failed (${res.status}): ${await res.text().then(t => t.slice(0, 200))}`); }
		} catch (err) { alert(`import failed: ${(err as Error).message}`); }
		finally { input.value = ''; }
	}

	async function loadAgentChannels(agentId: string) {
		// Fetch which channels this agent is a member of by checking all channels
		const res = await fetch('/api/channels?include_archived=0');
		if (!res.ok) return;
		const data = await res.json();
		const allCh = (data.channels ?? []) as { id: string; name: string }[];
		// Check membership by loading members for each channel — use parallel fetches
		const results = await Promise.all(
			allCh.map(async (ch) => {
				const r = await fetch(`/api/channels/${ch.id}/members`);
				if (!r.ok) return null;
				const d = await r.json();
				const isMember = (d.members ?? []).some((m: { id: string }) => m.id === agentId);
				return isMember ? ch : null;
			})
		);
		agentChannels = { ...agentChannels, [agentId]: results.filter(Boolean) as { id: string; name: string }[] };
	}

	async function addAgentToChannel(agentId: string, channelId: string) {
		const res = await fetch(`/api/channels/${channelId}/members`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ agent_id: agentId })
		});
		if (res.ok) await loadAgentChannels(agentId);
	}

	async function removeAgentFromChannel(agentId: string, channelId: string) {
		const res = await fetch(`/api/channels/${channelId}/members/${agentId}`, { method: 'DELETE' });
		if (res.ok) await loadAgentChannels(agentId);
	}

	async function loadChannelDetail(channelId: string) {
		channelDetail = null;
		editChannel = null;
		const res = await fetch(`/api/settings?channelId=${encodeURIComponent(channelId)}`);
		if (!res.ok) {
			loadError = `Failed to load channel settings: ${res.status}`;
			return;
		}
		const data = await res.json();
		channelDetail = data.channel as ChannelSettings;
		editChannel = {
			kbBudgetOverride: channelDetail.kbBudgetOverride,
			autoApprove: channelDetail.autoApprove,
			roundtripCapOverride: channelDetail.roundtripCapOverride
		};
		editChannelBudgetText = channelDetail.kbBudgetOverride?.toString() ?? '';
		editChannelRoundtripText = channelDetail.roundtripCapOverride?.toString() ?? '';
	}

	async function saveGlobal() {
		if (!editGlobal || !global) return;
		saveError = null;
		savingGlobal = true;
		try {
			// Svelte 5's `bind:value` on <input type="number"> bound to a
			// $state field does not reliably emit a number across all
			// configurations — the value can land in the field as a
			// string, which the zod-strict server rejects with 400. Force
			// the cast at the patch boundary so the wire is always
			// number-typed regardless of how the bind resolved.
			const editKb = Number(editGlobal.kbBudgetDefault);
			const origKb = Number(global.kbBudgetDefault);
			const editCap = Number(editGlobal.roundtripCapDefault);
			const origCap = Number(global.roundtripCapDefault);

			// Send only the keys that changed. Empty patch is a no-op
			// at the server but we still avoid the round-trip.
			const patch: Partial<Global> = {};
			if (editKb !== origKb) patch.kbBudgetDefault = editKb;
			if (editGlobal.showGroomedDefault !== global.showGroomedDefault)
				patch.showGroomedDefault = editGlobal.showGroomedDefault;
			if (editGlobal.hideSystemMessagesDefault !== global.hideSystemMessagesDefault)
				patch.hideSystemMessagesDefault = editGlobal.hideSystemMessagesDefault;
			if (editGlobal.defaultChannelId !== global.defaultChannelId)
				patch.defaultChannelId = editGlobal.defaultChannelId;
			if (editGlobal.theme !== global.theme) patch.theme = editGlobal.theme;
			if (editCap !== origCap) patch.roundtripCapDefault = editCap;

			if (Object.keys(patch).length === 0) return;

			const res = await fetch('/api/settings', {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(patch)
			});
			if (!res.ok) {
				const msg = await res.text().catch(() => '');
				// Surface the full server message; zod errors carry the
				// field path which is exactly what a future-me wants to
				// see when a bind-shape regresses.
				console.error('[settings] PATCH /api/settings failed', res.status, msg);
				saveError = `Save failed: ${res.status} ${msg.slice(0, 400)}`;
				return;
			}
			// The WS broadcast will reload + re-seed editGlobal. As a
			// belt-and-braces measure (e.g. if the WS is disconnected),
			// reload immediately too.
			await loadGlobal();
			applyThemeToHtml(global!.theme);
		} finally {
			savingGlobal = false;
		}
	}

	async function saveChannel() {
		if (!editChannel || !channelDetail) return;
		saveError = null;
		savingChannel = true;
		try {
			// Both override fields use text-bound inputs (Svelte 5 number
			// inputs with `placeholder` behave more predictably as text
			// with explicit parsing) so the parse is already manual; just
			// keep the existing validation.
			const budgetText = String(editChannelBudgetText).trim();
			let kbBudgetOverride: number | null;
			if (budgetText === '') {
				kbBudgetOverride = null;
			} else {
				const n = Number(budgetText);
				if (!Number.isInteger(n) || n < 1 || n > 100_000) {
					saveError = 'KB budget override must be an integer between 1 and 100000, or empty to inherit.';
					return;
				}
				kbBudgetOverride = n;
			}

			const rtText = String(editChannelRoundtripText).trim();
			let roundtripCapOverride: number | null;
			if (rtText === '') {
				roundtripCapOverride = null;
			} else {
				const n = Number(rtText);
				if (!Number.isInteger(n) || n < 1 || n > 100) {
					saveError = 'Roundtrip cap override must be an integer between 1 and 100, or empty to inherit.';
					return;
				}
				roundtripCapOverride = n;
			}

			const patch: {
				kbBudgetOverride?: number | null;
				autoApprove?: boolean;
				roundtripCapOverride?: number | null;
			} = {};
			if (kbBudgetOverride !== channelDetail.kbBudgetOverride)
				patch.kbBudgetOverride = kbBudgetOverride;
			if (editChannel.autoApprove !== channelDetail.autoApprove)
				patch.autoApprove = editChannel.autoApprove;
			if (roundtripCapOverride !== channelDetail.roundtripCapOverride)
				patch.roundtripCapOverride = roundtripCapOverride;

			if (Object.keys(patch).length === 0) return;

			const res = await fetch(`/api/settings/channel/${encodeURIComponent(selected)}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(patch)
			});
			if (!res.ok) {
				const msg = await res.text().catch(() => '');
				console.error(
					'[settings] PATCH /api/settings/channel failed',
					res.status,
					msg
				);
				saveError = `Save failed: ${res.status} ${msg.slice(0, 400)}`;
				return;
			}
			await loadChannelDetail(selected);
		} finally {
			savingChannel = false;
		}
	}

	async function resetChannelToGlobal() {
		if (!confirm('Reset all per-channel overrides for this channel?')) return;
		const res = await fetch(`/api/settings/channel/${encodeURIComponent(selected)}`, {
			method: 'DELETE'
		});
		if (!res.ok) {
			saveError = `Reset failed: ${res.status}`;
			return;
		}
		await loadChannelDetail(selected);
	}

	function discardGlobal() {
		if (global) editGlobal = { ...global };
	}

	function discardChannel() {
		if (channelDetail) {
			editChannel = {
				kbBudgetOverride: channelDetail.kbBudgetOverride,
				autoApprove: channelDetail.autoApprove,
				roundtripCapOverride: channelDetail.roundtripCapOverride
			};
			editChannelBudgetText = channelDetail.kbBudgetOverride?.toString() ?? '';
			editChannelRoundtripText = channelDetail.roundtripCapOverride?.toString() ?? '';
		}
	}

	let _themeMediaQuery: MediaQueryList | null = null;

	function applyThemeToHtml(theme: Theme) {
		if (typeof document === 'undefined') return;
		if (theme === 'system') {
			const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
			document.documentElement.dataset.theme = prefersDark ? 'dark' : 'light';
		} else {
			document.documentElement.dataset.theme = theme;
		}
	}

	function listenSystemTheme() {
		if (typeof window === 'undefined') return;
		_themeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
		_themeMediaQuery.addEventListener('change', () => {
			if (global?.theme === 'system') applyThemeToHtml('system');
		});
	}

	function connectWs() {
		// Same path as the main app's WS (/ws). We only listen for the
		// settings entity; everything else is ignored.
		const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		const url = `${proto}//${window.location.host}/ws`;
		try {
			ws = new WebSocket(url);
		} catch {
			return;
		}
		ws.onmessage = async (ev) => {
			let msg: WSStateChanged;
			try {
				msg = JSON.parse(ev.data);
			} catch {
				return;
			}
			if (msg.type !== 'state_changed') return;
			if (msg.entity === 'agent') {
				await loadAgents();
				return;
			}
			if (msg.entity !== 'settings') return;
			if (msg.id === 'global') {
				await loadGlobal();
				// If we're viewing a per-channel pane, the effective
				// values may have moved too (inherited budget changes).
				if (selected !== 'global') await loadChannelDetail(selected);
			} else if (msg.id === selected) {
				await loadChannelDetail(selected);
			}
		};
	}

	$effect(() => {
		if (selected === 'global' || selected === 'agents') {
			channelDetail = null;
			editChannel = null;
		} else if (selected) {
			loadChannelDetail(selected);
		}
	});

	onMount(async () => {
		await Promise.all([loadGlobal(), loadChannels(), loadAgents()]);
		if (global) applyThemeToHtml(global.theme);
		listenSystemTheme();
		// Deep-link via /settings#<channelId>. The channel-header gear
		// in +page.svelte produces such a link. Hash takes effect after
		// the channel list has loaded so the selection is recognised.
		const hash = window.location.hash.replace(/^#/, '');
		if (hash && channels.some((c) => c.id === hash)) {
			selected = hash;
		}
		window.addEventListener('hashchange', onHashChange);
		connectWs();
	});

	function onHashChange() {
		const hash = window.location.hash.replace(/^#/, '');
		if (hash === '' || hash === 'global') {
			selected = 'global';
		} else if (channels.some((c) => c.id === hash)) {
			selected = hash;
		}
	}

	onDestroy(() => {
		ws?.close();
		ws = null;
		if (typeof window !== 'undefined') {
			window.removeEventListener('hashchange', onHashChange);
		}
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
			<div class="rail-divider">Agents</div>
			<button
				type="button"
				class:active={selected === 'agents'}
				onclick={() => (selected = 'agents')}
			>
				Manage Agents
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
		{#if saveError}
			<p class="error">{saveError}</p>
		{/if}

		{#if selected === 'global'}
			<h1>Global settings</h1>
			<p class="note">
				These values are the default for every channel. Per-channel overrides win when set.
			</p>
			{#if editGlobal && global}
				<form
					onsubmit={(e) => {
						e.preventDefault();
						saveGlobal();
					}}
				>
					<div class="field">
						<label for="kb-budget">Initial-load KB budget</label>
						<input
							id="kb-budget"
							type="number"
							min="1"
							max="100000"
							step="1"
							bind:value={editGlobal.kbBudgetDefault}
						/>
						<span class="unit">KB</span>
					</div>

					<div class="field">
						<label for="show-groomed">Show groomed messages by default</label>
						<input
							id="show-groomed"
							type="checkbox"
							bind:checked={editGlobal.showGroomedDefault}
						/>
					</div>

					<div class="field">
						<label for="hide-system">Hide system messages by default</label>
						<input
							id="hide-system"
							type="checkbox"
							bind:checked={editGlobal.hideSystemMessagesDefault}
						/>
					</div>

					<div class="field">
						<label for="default-channel">Default channel on open</label>
						<select
							id="default-channel"
							value={editGlobal.defaultChannelId ?? ''}
							onchange={(e) => {
								const v = (e.target as HTMLSelectElement).value;
								editGlobal!.defaultChannelId = v === '' ? null : v;
							}}
						>
							<option value="">— (last-active)</option>
							{#each channels as ch (ch.id)}
								<option value={ch.id}>{ch.name}</option>
							{/each}
						</select>
					</div>

					<div class="field">
						<label for="theme">Theme</label>
						<select id="theme" bind:value={editGlobal.theme}>
							<option value="system">system</option>
							<option value="light">light</option>
							<option value="dark">dark</option>
						</select>
						<span class="hint">
							(stored now; actual dark-mode stylesheet lands in a future PR)
						</span>
					</div>

					<div class="field">
						<label for="roundtrip-cap">Agent-to-agent roundtrip cap</label>
						<input
							id="roundtrip-cap"
							type="number"
							min="1"
							max="100"
							step="1"
							bind:value={editGlobal.roundtripCapDefault}
						/>
						<span class="unit">hops</span>
						<span class="hint">
							Per user-message window. Resets on every user message. Loop
							defence for auto-approve channels (ADR-0020).
						</span>
					</div>

					<div class="actions">
						<button type="submit" disabled={!dirtyGlobal || savingGlobal}>
							{savingGlobal ? 'Saving…' : 'Save'}
						</button>
						<button
							type="button"
							class="secondary"
							onclick={discardGlobal}
							disabled={!dirtyGlobal || savingGlobal}
						>
							Discard
						</button>
					</div>
				</form>
			{:else if !loadError}
				<p>Loading…</p>
			{/if}
		{:else}
			<h1>Channel: {channelName(selected)}</h1>
			<p class="note">
				Per-channel overrides for <strong>{channelName(selected)}</strong>. Empty values inherit
				the global default.
			</p>
			{#if editChannel && channelDetail && global}
				<form
					onsubmit={(e) => {
						e.preventDefault();
						saveChannel();
					}}
				>
					<div class="field">
						<label for="kb-budget-ov">KB budget override</label>
						<input
							id="kb-budget-ov"
							type="number"
							min="1"
							max="100000"
							step="1"
							placeholder={`inherit (${global.kbBudgetDefault})`}
							bind:value={editChannelBudgetText}
						/>
						<span class="unit">KB</span>
						<span class="hint">Empty = inherit global ({global.kbBudgetDefault} KB).</span>
					</div>

					<div class="field">
						<label for="auto-approve">Auto-approve agent-to-agent mentions</label>
						<input
							id="auto-approve"
							type="checkbox"
							bind:checked={editChannel.autoApprove}
						/>
						<span class="hint">
							When enabled, mentions from one agent to another in this channel
							skip the approval queue. UI for the audit log lands with the
							ADR-0015 PR stack.
						</span>
					</div>

					<div class="field">
						<label for="roundtrip-cap-ov">Roundtrip cap override</label>
						<input
							id="roundtrip-cap-ov"
							type="number"
							min="1"
							max="100"
							step="1"
							placeholder={`inherit (${global.roundtripCapDefault})`}
							bind:value={editChannelRoundtripText}
						/>
						<span class="unit">hops</span>
						<span class="hint">
							Empty = inherit global ({global.roundtripCapDefault}).
						</span>
					</div>

					<div class="actions">
						<button type="submit" disabled={!dirtyChannel || savingChannel}>
							{savingChannel ? 'Saving…' : 'Save'}
						</button>
						<button
							type="button"
							class="secondary"
							onclick={discardChannel}
							disabled={!dirtyChannel || savingChannel}
						>
							Discard
						</button>
						<button
							type="button"
							class="danger"
							onclick={resetChannelToGlobal}
							disabled={savingChannel}
						>
							Reset to global
						</button>
					</div>
				</form>
			{:else if !loadError}
				<p>Loading…</p>
			{/if}
		{/if}

		{#if selected === 'agents'}
			<h1>Agents</h1>
			<p class="note">Manage all agents. Assign them to channels here or from the channel view.</p>

			<div class="agent-toolbar">
				<button type="button" class="primary" onclick={() => { agentFormMode = 'create'; editingAgent = null; }}>
					+ New Agent
				</button>
				<button type="button" title="Import agent from JSON file" onclick={triggerLoadAgent}>
					⇧ Upload Agent
				</button>
				<input
					bind:this={loadAgentInput}
					type="file"
					accept="application/json,.json"
					style="display:none"
					onchange={onLoadAgentFile}
				/>
			</div>

			{#if agentsLoading}
				<p class="note">Loading…</p>
			{:else if agentsList.length === 0}
				<p class="note empty">No agents yet. Create one to get started.</p>
			{:else}
				<div class="agent-list">
					{#each agentsList as agent (agent.id)}
						<div class="agent-card">
							<div class="agent-card-header">
								<div class="agent-info">
									<span class="dot" class:disabled={!agent.enabled}></span>
									<span class="agent-name">{agent.name}</span>
									<span class="agent-type">{agent.connectorType}</span>
								</div>
								<div class="agent-row-actions">
									<button type="button" onclick={() => toggleAgentEnabled(agent)}>
										{agent.enabled ? 'Disable' : 'Enable'}
									</button>
									<button type="button" onclick={() => openEditAgent(agent)}>Edit</button>
									<button type="button" onclick={() => saveAgentToFile(agent)} title="Export agent to JSON">⇩ Save</button>
									<button type="button" class="danger" onclick={() => archiveAgent(agent)}>Archive</button>
								</div>
							</div>

							<div class="agent-channels">
								{#if !agentChannels[agent.id]}
									<button type="button" class="load-channels-btn" onclick={() => loadAgentChannels(agent.id)}>
										Show channel assignments
									</button>
								{:else}
									<span class="channels-label">Channels:</span>
									{#each agentChannels[agent.id] as ch (ch.id)}
										<span class="channel-chip">
											#{ch.name}
											<button type="button" class="chip-remove" onclick={() => removeAgentFromChannel(agent.id, ch.id)}
												title="Remove from #{ch.name}">×</button>
										</span>
									{/each}
									<select
										class="add-channel-select"
										onchange={(e) => {
											const chId = (e.target as HTMLSelectElement).value;
											if (chId) addAgentToChannel(agent.id, chId);
											(e.target as HTMLSelectElement).value = '';
										}}
									>
										<option value="">+ Add to channel…</option>
										{#each channels.filter(ch => !(agentChannels[agent.id] ?? []).some(m => m.id === ch.id)) as ch (ch.id)}
											<option value={ch.id}>#{ch.name}</option>
										{/each}
									</select>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			{/if}
		{/if}
	</main>
</div>

{#if agentFormMode !== 'none'}
	<AgentForm
		mode={agentFormMode === 'create' ? 'create' : 'edit'}
		agent={editingAgent ?? undefined}
		onSubmit={submitAgentForm}
		onCancel={() => { agentFormMode = 'none'; editingAgent = null; }}
	/>
{/if}

<style>
	/*
	 * Styled to match the channel-view dark palette
	 * (#0e0e10 / #16161a / #1f1f24 / #2a2a30 / #e8e8ea / #94a3b8).
	 * Channel view (+page.svelte) and protocol search keep their own
	 * scoped styles; this page reads the same palette so the side rail
	 * doesn't flash white on navigation.
	 */
	.settings-page {
		display: grid;
		grid-template-columns: 240px 1fr;
		min-height: 100vh;
	}

	.rail {
		border-right: 1px solid var(--finn-border);
		padding: var(--finn-space-4);
		background: var(--finn-bg-elevated);
	}

	.rail h2 {
		margin: 0 0 12px 0;
		font-size: var(--finn-text-xs);
		text-transform: uppercase;
		letter-spacing: 0.08em;
		font-weight: 600;
		color: var(--finn-text-muted);
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
		border-radius: var(--finn-radius-sm);
		cursor: pointer;
		font: inherit;
		color: var(--finn-text-secondary);
		transition: background var(--finn-transition-fast);
	}

	.rail button:hover {
		background: var(--finn-bg-hover);
	}

	.rail button.active {
		background: var(--finn-accent-soft);
		color: var(--finn-accent-hover);
		font-weight: 600;
	}

	.rail-divider {
		margin-top: 12px;
		padding: 4px 10px;
		font-size: var(--finn-text-xs);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--finn-text-muted);
	}

	.rail-empty {
		padding: 6px 10px;
		color: var(--finn-text-muted);
		font-style: italic;
		font-size: var(--finn-text-sm);
	}

	.rail-foot {
		margin-top: 24px;
		font-size: var(--finn-text-sm);
	}

	.rail-foot a {
		color: var(--finn-success);
		text-decoration: none;
	}

	.rail-foot a:hover {
		color: var(--finn-text-primary);
	}

	.pane {
		padding: 24px 32px;
		max-width: 720px;
	}

	.pane h1 {
		margin-top: 0;
		color: var(--finn-text-primary);
	}

	.note {
		color: var(--finn-text-secondary);
		font-size: var(--finn-text-sm);
		max-width: 60ch;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 16px;
		margin-top: 24px;
	}

	.field {
		display: grid;
		grid-template-columns: 240px max-content max-content;
		align-items: center;
		gap: 8px 12px;
	}

	.field label {
		font-weight: 600;
		color: var(--finn-text-secondary);
	}

	.field input[type='number'],
	.field select {
		background: var(--finn-bg-input);
		color: var(--finn-text-primary);
		border: 1px solid var(--finn-border);
		border-radius: var(--finn-radius-sm);
		font: inherit;
		transition: border-color var(--finn-transition-fast);
	}

	.field input[type='number']:focus,
	.field select:focus {
		outline: none;
		border-color: var(--finn-accent);
	}

	.field input[type='number'] {
		width: 120px;
		padding: 4px 6px;
	}

	.field select {
		padding: 4px 6px;
		min-width: 180px;
	}

	.field input[type='checkbox'] {
		accent-color: var(--finn-accent);
		width: 16px;
		height: 16px;
	}

	.field .unit {
		color: var(--finn-text-secondary);
	}

	.field .hint {
		grid-column: 2 / -1;
		color: var(--finn-text-muted);
		font-size: var(--finn-text-xs);
		margin-top: 2px;
	}

	.actions {
		display: flex;
		gap: 8px;
		margin-top: 12px;
	}

	.actions button {
		padding: 6px 14px;
		font: inherit;
		cursor: pointer;
		border: 1px solid var(--finn-border);
		background: var(--finn-bg-surface);
		color: var(--finn-text-secondary);
		border-radius: var(--finn-radius-sm);
		transition: background var(--finn-transition-fast);
	}

	.actions button:hover:not(:disabled) {
		background: var(--finn-bg-hover);
	}

	.actions button:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.actions button.secondary {
		background: transparent;
		color: var(--finn-text-secondary);
	}

	.actions button.secondary:hover:not(:disabled) {
		background: var(--finn-bg-hover);
	}

	.actions button.danger {
		background: transparent;
		color: var(--finn-error);
		border-color: var(--finn-error);
		margin-left: auto;
	}

	.actions button.danger:hover:not(:disabled) {
		background: var(--finn-error-bg);
	}

	.error {
		color: var(--finn-error);
		background: var(--finn-error-bg);
		border: 1px solid var(--finn-error);
		padding: 8px 12px;
		border-radius: var(--finn-radius-sm);
	}
	/* ── Agent management pane ──────────────────────────────────────────── */
	.agent-toolbar {
		display: flex;
		gap: 0.5rem;
		margin: 1rem 0;
	}
	.agent-toolbar button {
		background: var(--finn-bg-surface);
		color: var(--finn-text-secondary);
		border: 1px solid var(--finn-border);
		padding: 0.4rem 0.85rem;
		font-family: inherit;
		font-size: var(--finn-text-sm);
		border-radius: var(--finn-radius-sm);
		cursor: pointer;
		transition: background var(--finn-transition-fast);
	}
	.agent-toolbar button:hover { background: var(--finn-bg-hover); }
	.agent-toolbar button.primary {
		background: var(--finn-accent);
		border-color: var(--finn-accent);
		color: #fff;
		font-weight: 500;
	}
	.agent-toolbar button.primary:hover {
		background: var(--finn-accent-hover);
		box-shadow: var(--finn-shadow-glow);
	}
	.agent-list {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		margin-top: 0.5rem;
	}
	.agent-card {
		background: var(--finn-bg-surface);
		border: 1px solid var(--finn-border);
		border-radius: var(--finn-radius-md);
		transition: border-color var(--finn-transition-fast);
		overflow: hidden;
	}
	.agent-card:hover { border-color: var(--finn-border-hover); }
	.agent-card-header {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.6rem 0.85rem;
	}
	.agent-info {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		background: var(--finn-success);
		display: inline-block;
		flex-shrink: 0;
	}
	.dot.disabled { background: var(--finn-text-disabled); }
	.agent-name {
		font-weight: 600;
		color: var(--finn-text-primary);
		font-size: var(--finn-text-sm);
	}
	.agent-type {
		font-size: var(--finn-text-xs);
		color: var(--finn-text-muted);
	}
	.agent-row-actions {
		display: flex;
		gap: 0.35rem;
	}
	.agent-row-actions button {
		background: var(--finn-bg-elevated);
		color: var(--finn-text-secondary);
		border: 1px solid var(--finn-border);
		padding: 0.2rem 0.55rem;
		font-family: inherit;
		font-size: var(--finn-text-xs);
		border-radius: var(--finn-radius-sm);
		cursor: pointer;
		transition: background var(--finn-transition-fast);
	}
	.agent-row-actions button:hover { background: var(--finn-bg-hover); }
	.agent-row-actions button.danger { color: var(--finn-error); border-color: var(--finn-error); }
	.agent-row-actions button.danger:hover { background: var(--finn-error-bg); }
	.agent-channels {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.35rem;
		padding: 0.45rem 0.85rem;
		border-top: 1px solid var(--finn-border);
		background: var(--finn-bg-elevated);
	}
	.channels-label {
		font-size: var(--finn-text-xs);
		color: var(--finn-text-muted);
		margin-right: 0.15rem;
	}
	.channel-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		background: var(--finn-accent-soft);
		color: var(--finn-accent-hover);
		padding: 0.1rem 0.4rem 0.1rem 0.5rem;
		border-radius: var(--finn-radius-full);
		font-size: var(--finn-text-xs);
	}
	.chip-remove {
		background: transparent;
		border: none;
		color: inherit;
		cursor: pointer;
		padding: 0;
		font-size: 0.9em;
		opacity: 0.7;
	}
	.chip-remove:hover { opacity: 1; }
	.add-channel-select {
		background: var(--finn-bg-input);
		color: var(--finn-text-secondary);
		border: 1px solid var(--finn-border);
		border-radius: var(--finn-radius-sm);
		padding: 0.15rem 0.4rem;
		font-family: inherit;
		font-size: var(--finn-text-xs);
		cursor: pointer;
	}
	.load-channels-btn {
		background: transparent;
		border: none;
		color: var(--finn-text-muted);
		font-size: var(--finn-text-xs);
		cursor: pointer;
		padding: 0;
		text-decoration: underline;
	}
	.load-channels-btn:hover { color: var(--finn-text-secondary); }
	.note.empty {
		font-style: italic;
		color: var(--finn-text-muted);
	}
</style>
