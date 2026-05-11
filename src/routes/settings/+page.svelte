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

	type Theme = 'system' | 'light' | 'dark';

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
	let selected = $state<string>('global'); // 'global' | channelId
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

	function dirtyGlobal(): boolean {
		if (!global || !editGlobal) return false;
		return (
			editGlobal.kbBudgetDefault !== global.kbBudgetDefault ||
			editGlobal.showGroomedDefault !== global.showGroomedDefault ||
			editGlobal.hideSystemMessagesDefault !== global.hideSystemMessagesDefault ||
			editGlobal.defaultChannelId !== global.defaultChannelId ||
			editGlobal.theme !== global.theme ||
			editGlobal.roundtripCapDefault !== global.roundtripCapDefault
		);
	}

	function parseNullableInt(text: string, fallback: number | null): number | null {
		const t = text.trim();
		if (t === '') return null;
		const n = Number(t);
		return Number.isFinite(n) ? n : fallback;
	}

	function dirtyChannel(): boolean {
		if (!channelDetail || !editChannel) return false;
		const editBudget = parseNullableInt(editChannelBudgetText, editChannel.kbBudgetOverride);
		const editRoundtrip = parseNullableInt(editChannelRoundtripText, editChannel.roundtripCapOverride);
		return (
			editBudget !== channelDetail.kbBudgetOverride ||
			editRoundtrip !== channelDetail.roundtripCapOverride ||
			editChannel.autoApprove !== channelDetail.autoApprove
		);
	}

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
		channels = (data.channels as ChannelInfo[]).slice().sort((a, b) => a.name.localeCompare(b.name));
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
			// Send only the keys that changed. Empty patch is a no-op
			// at the server but we still avoid the round-trip.
			const patch: Partial<Global> = {};
			if (editGlobal.kbBudgetDefault !== global.kbBudgetDefault)
				patch.kbBudgetDefault = editGlobal.kbBudgetDefault;
			if (editGlobal.showGroomedDefault !== global.showGroomedDefault)
				patch.showGroomedDefault = editGlobal.showGroomedDefault;
			if (editGlobal.hideSystemMessagesDefault !== global.hideSystemMessagesDefault)
				patch.hideSystemMessagesDefault = editGlobal.hideSystemMessagesDefault;
			if (editGlobal.defaultChannelId !== global.defaultChannelId)
				patch.defaultChannelId = editGlobal.defaultChannelId;
			if (editGlobal.theme !== global.theme) patch.theme = editGlobal.theme;
			if (editGlobal.roundtripCapDefault !== global.roundtripCapDefault)
				patch.roundtripCapDefault = editGlobal.roundtripCapDefault;

			if (Object.keys(patch).length === 0) return;

			const res = await fetch('/api/settings', {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(patch)
			});
			if (!res.ok) {
				const msg = await res.text().catch(() => '');
				saveError = `Save failed: ${res.status} ${msg.slice(0, 200)}`;
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
			const budgetText = editChannelBudgetText.trim();
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

			const rtText = editChannelRoundtripText.trim();
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
				saveError = `Save failed: ${res.status} ${msg.slice(0, 200)}`;
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

	function applyThemeToHtml(theme: Theme) {
		// Minimal theme-attribute hook. Actual dark-mode CSS-variable
		// restyling is deliberately out of scope of ADR-0019 — this
		// just makes the picker functional and persists the choice,
		// so a future styling PR has somewhere to read from.
		if (typeof document !== 'undefined') {
			document.documentElement.dataset.theme = theme;
		}
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
			if (msg.type !== 'state_changed' || msg.entity !== 'settings') return;
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
		if (selected === 'global') {
			channelDetail = null;
			editChannel = null;
		} else if (selected) {
			loadChannelDetail(selected);
		}
	});

	onMount(async () => {
		await Promise.all([loadGlobal(), loadChannels()]);
		if (global) applyThemeToHtml(global.theme);
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
						<button type="submit" disabled={!dirtyGlobal() || savingGlobal}>
							{savingGlobal ? 'Saving…' : 'Save'}
						</button>
						<button
							type="button"
							class="secondary"
							onclick={discardGlobal}
							disabled={!dirtyGlobal() || savingGlobal}
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
						<button type="submit" disabled={!dirtyChannel() || savingChannel}>
							{savingChannel ? 'Saving…' : 'Save'}
						</button>
						<button
							type="button"
							class="secondary"
							onclick={discardChannel}
							disabled={!dirtyChannel() || savingChannel}
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
	</main>
</div>

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
		background: #0e0e10;
		color: #e8e8ea;
	}

	.rail {
		border-right: 1px solid #2a2a30;
		padding: 16px;
		background: #16161a;
	}

	.rail h2 {
		margin: 0 0 12px 0;
		font-size: 1rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: #94a3b8;
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
		color: #cbd5e1;
	}

	.rail button:hover {
		background: #1f1f24;
	}

	.rail button.active {
		background: #2a2a30;
		color: #e8e8ea;
		font-weight: 600;
	}

	.rail-divider {
		margin-top: 12px;
		padding: 4px 10px;
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: #64748b;
	}

	.rail-empty {
		padding: 6px 10px;
		color: #64748b;
		font-style: italic;
		font-size: 0.9rem;
	}

	.rail-foot {
		margin-top: 24px;
		font-size: 0.85rem;
	}

	.rail-foot a {
		color: #6ee7b7;
		text-decoration: none;
	}

	.rail-foot a:hover {
		color: #a7f3d0;
	}

	.pane {
		padding: 24px 32px;
		max-width: 720px;
	}

	.pane h1 {
		margin-top: 0;
		color: #f1f5f9;
	}

	.note {
		color: #94a3b8;
		font-size: 0.9rem;
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
		color: #cbd5e1;
	}

	.field input[type='number'],
	.field select {
		background: #1f1f24;
		color: #e8e8ea;
		border: 1px solid #2a2a30;
		border-radius: 4px;
		font: inherit;
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
		accent-color: #6ee7b7;
		width: 16px;
		height: 16px;
	}

	.field .unit {
		color: #94a3b8;
	}

	.field .hint {
		grid-column: 2 / -1;
		color: #64748b;
		font-size: 0.8rem;
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
		border: 1px solid #2a2a30;
		background: #1f2937;
		color: #f1f5f9;
		border-radius: 4px;
	}

	.actions button:hover:not(:disabled) {
		background: #2a3441;
	}

	.actions button:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.actions button.secondary {
		background: transparent;
		color: #cbd5e1;
	}

	.actions button.secondary:hover:not(:disabled) {
		background: #1f1f24;
	}

	.actions button.danger {
		background: transparent;
		color: #fca5a5;
		border-color: #4a1f1f;
		margin-left: auto;
	}

	.actions button.danger:hover:not(:disabled) {
		background: #3a1a1a;
	}

	.error {
		color: #fca5a5;
		background: #3a1a1a;
		border: 1px solid #4a1f1f;
		padding: 8px 12px;
		border-radius: 4px;
	}
</style>
