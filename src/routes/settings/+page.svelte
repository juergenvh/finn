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

	type ConnectorType = 'openclaw' | 'openai-compatible' | 'anthropic-stub';
	type AgentInfo = {
		id: string;
		name: string;
		connectorType: ConnectorType;
		enabled: boolean;
		config: Record<string, unknown>;
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

	type ChannelInfo = { id: string; name: string; description: string | null };

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
	let expandedAgentId = $state<string | null>(null);
	let newAgentMode = $state(false);

	type AgentDraft = {
		name: string; enabled: boolean; connectorType: ConnectorType;
		openclawBaseUrl: string; openclawTokenEnvVar: string; openclawModel: string; openclawSessionOverride: string;
		oaiCompatBaseUrl: string; oaiCompatTokenEnvVar: string; oaiCompatModelHint: string;
		stubPersona: string; stubRepliesText: string;
		saving: boolean; error: string | null;
	};
	let agentDrafts = $state<Record<string, AgentDraft>>({});

	function freshDraft(a?: AgentInfo): AgentDraft {
		const cfg = (a?.config ?? {}) as Record<string, unknown>;
		return {
			name: a?.name ?? '', enabled: a?.enabled ?? true, connectorType: a?.connectorType ?? 'openclaw',
			openclawBaseUrl: (cfg.base_url as string) ?? 'http://127.0.0.1:18789/v1',
			openclawTokenEnvVar: (cfg.token_env_var as string) ?? 'FINN_OPENCLAW_API_KEY',
			openclawModel: (cfg.model as string) ?? 'openclaw',
			openclawSessionOverride: (cfg.session_override as string) ?? '',
			oaiCompatBaseUrl: (cfg.base_url as string) ?? 'https://agent.example.com/v1',
			oaiCompatTokenEnvVar: (cfg.token_env_var as string) ?? 'FINN_OPENAI_COMPAT_API_KEY',
			oaiCompatModelHint: (cfg.model_hint as string) ?? 'default',
			stubPersona: (cfg.persona as string) ?? 'a generic assistant',
			stubRepliesText: Array.isArray(cfg.replies) ? (cfg.replies as string[]).join('\n') : 'notiert.\ninteressant. @dixie?\ních bleibe skeptisch.',
			saving: false, error: null
		};
	}
	let newAgentDraft = $state<AgentDraft>(freshDraft());
	// channel membership per agent: agentId → array of {id, name}
	let agentChannels = $state<Record<string, { id: string; name: string }[]>>({});
	// hidden <input type=file> for "Load agent from JSON" (bound in markup below)
	let loadAgentInput: HTMLInputElement | null = $state(null);

	// ── Channel management state ───────────────────────────────────
	let newChannelMode = $state(false);
	let newChannelName = $state('');
	let newChannelDesc = $state('');
	let newChannelSaving = $state(false);
	let editingChannel = $state<(typeof channels)[0] | null>(null);
	let editingChannelMembers = $state<string[]>([]);
	// agent membership per channel: channelId → array of {id, name}
	let channelMemberMap = $state<Record<string, { id: string; name: string }[]>>({});
	// inline channel name/description editing
	let inlineEditChannelId = $state<string | null>(null);
	let inlineEditName = $state('');
	let inlineEditDesc = $state('');
	let inlineEditSaving = $state(false);
	let channelDetail = $state<ChannelSettings | null>(null);
	let loadError = $state<string | null>(null);
	let saveError = $state<string | null>(null);
	let savingGlobal = $state(false);
	let savingChannel = $state(false);

	// Editable buffers for Global pane.
	let editGlobal = $state<Global | null>(null);
	let editChannel = $state<{
		kbBudgetOverride: number | null;
		autoApprove: boolean;
		roundtripCapOverride: number | null;
	} | null>(null);
	let editChannelBudgetText = $state<string>('');
	let editChannelRoundtripText = $state<string>('');

	// Per-channel inline settings (Channels pane)
	type ChEdit = { budgetText: string; autoApprove: boolean; roundtripText: string; saving: boolean; };
	let channelDetailsMap = $state<Record<string, ChannelSettings>>({});
	let channelEditsMap = $state<Record<string, ChEdit>>({});

	let ws: WebSocket | null = null;
	let wsStopped = false;
	let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let wsReconnectAttempt = 0;

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
		channels = data.channels as ChannelInfo[];
		// Member maps and settings loaded by callers that need channels first
	}

	async function loadAgents() {
		agentsLoading = true;
		try {
			const res = await fetch('/api/agents?include_archived=0');
			if (!res.ok) return;
			const data = await res.json();
			agentsList = data.agents as AgentInfo[];
			// Channel assignments loaded separately after channels are available
		} finally {
			agentsLoading = false;
		}
	}

	async function loadAllAgentChannels() {
		const newMap: Record<string, { id: string; name: string }[]> = {};
		await Promise.all(
			channels.map(async (ch) => {
				const r = await fetch(`/api/channels/${ch.id}/members`);
				if (!r.ok) return;
				const d = await r.json();
				for (const m of (d.members ?? []) as { id: string }[]) {
					if (!newMap[m.id]) newMap[m.id] = [];
					newMap[m.id].push({ id: ch.id, name: ch.name });
				}
			})
		);
		agentChannels = newMap;
	}

	async function loadAllChannelMembers() {
		const newMap: Record<string, { id: string; name: string }[]> = {};
		await Promise.all(
			channels.map(async (ch) => {
				const r = await fetch(`/api/channels/${ch.id}/members`);
				if (!r.ok) return;
				const d = await r.json();
				newMap[ch.id] = (d.members ?? []).map((m: { id: string; name: string }) => ({
					id: m.id,
					name: m.name
				}));
			})
		);
		channelMemberMap = newMap;
	}

	async function expandAgent(agent: AgentInfo) {
		if (expandedAgentId === agent.id) { expandedAgentId = null; return; }
		// Load full config before expanding
		const res = await fetch(`/api/agents/${agent.id}`);
		if (!res.ok) return;
		const data = await res.json();
		const full: AgentInfo = { ...agent, config: data.config ?? {} };
		agentDrafts = { ...agentDrafts, [agent.id]: freshDraft(full) };
		expandedAgentId = agent.id;
	}

	function patchDraft(id: string, patch: Partial<AgentDraft>) {
		agentDrafts = { ...agentDrafts, [id]: { ...agentDrafts[id], ...patch } };
	}

	function buildConfig(d: AgentDraft): Record<string, unknown> {
		if (d.connectorType === 'openclaw') {
			const cfg: Record<string, unknown> = {
				connector_type: 'openclaw',
				base_url: d.openclawBaseUrl.trim(),
				token_env_var: d.openclawTokenEnvVar.trim(),
				model: d.openclawModel.trim()
			};
			if (d.openclawSessionOverride.trim()) cfg.session_override = d.openclawSessionOverride.trim();
			return cfg;
		}
		if (d.connectorType === 'openai-compatible') return {
			connector_type: 'openai-compatible',
			base_url: d.oaiCompatBaseUrl.trim(),
			token_env_var: d.oaiCompatTokenEnvVar.trim(),
			model_hint: d.oaiCompatModelHint.trim()
		};
		return {
			connector_type: 'anthropic-stub',
			persona: d.stubPersona.trim(),
			replies: d.stubRepliesText.split('\n').map(s => s.trim()).filter(Boolean)
		};
	}

	async function saveAgentDraft(agentId: string) {
		const d = agentDrafts[agentId];
		if (!d || !d.name.trim()) return;
		patchDraft(agentId, { saving: true, error: null });
		try {
			const res = await fetch(`/api/agents/${agentId}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name: d.name.trim(), enabled: d.enabled, config: buildConfig(d) })
			});
			if (!res.ok) { patchDraft(agentId, { error: `HTTP ${res.status}` }); return; }
			expandedAgentId = null;
			await loadAgents();
		} finally { patchDraft(agentId, { saving: false }); }
	}

	async function saveNewAgent() {
		const d = newAgentDraft;
		if (!d.name.trim()) return;
		newAgentDraft = { ...newAgentDraft, saving: true, error: null };
		try {
			const res = await fetch('/api/agents', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name: d.name.trim(), enabled: d.enabled, config: buildConfig(d) })
			});
			if (!res.ok) { newAgentDraft = { ...newAgentDraft, error: `HTTP ${res.status}` }; return; }
			newAgentMode = false;
			newAgentDraft = freshDraft();
			await loadAgents();
		} finally { newAgentDraft = { ...newAgentDraft, saving: false }; }
	}

	async function archiveAgent(agent: AgentInfo) {
		if (!confirm(`Archive agent "${agent.name}"?`)) return;
		const res = await fetch(`/api/agents/${agent.id}`, { method: 'DELETE' });
		if (res.ok) { expandedAgentId = null; await loadAgents(); }
	}

	async function toggleAgentEnabled(agent: AgentInfo) {
		const res = await fetch(`/api/agents/${agent.id}`, {
			method: 'PATCH', headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ enabled: !agent.enabled })
		});
		if (res.ok) await loadAgents();
	}

	async function saveAgentToFile(agent: AgentInfo) {
		try {
			const res = await fetch(`/api/agents/${agent.id}`);
			if (!res.ok) { alert(`failed: ${res.status}`); return; }
			const row = await res.json();
			const envelope = { schema: AGENT_EXPORT_SCHEMA, exportedAt: new Date().toISOString(),
				agent: { name: row.name, connectorType: row.connectorType, config: row.config } };
			const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url; a.download = `finn-agent-${row.name}.json`;
			document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
		} catch (err) { alert(`export failed: ${(err as Error).message}`); }
	}

	function triggerLoadAgent() { loadAgentInput?.click(); }

	async function onLoadAgentFile(ev: Event) {
		const input = ev.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		try {
			const parsed = JSON.parse(await file.text());
			if (parsed?.schema !== AGENT_EXPORT_SCHEMA) { alert(`unrecognised file (expected ${AGENT_EXPORT_SCHEMA})`); return; }
			const a = parsed.agent;
			if (!a?.name || !a?.connectorType || !a?.config) { alert('file missing required fields'); return; }
			const res = await fetch('/api/agents', { method: 'POST', headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name: a.name, config: a.config, enabled: true }) });
			if (!res.ok) alert(`import failed: ${res.status}`);
			else await loadAgents();
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

	// ── Channel CRUD ─────────────────────────────────────────────
	function startInlineEdit(ch: (typeof channels)[0]) {
		inlineEditChannelId = ch.id;
		inlineEditName = ch.name;
		inlineEditDesc = ch.description ?? '';
	}

	function cancelInlineEdit() { inlineEditChannelId = null; }
	async function saveNewChannel() {
		if (!newChannelName.trim()) return;
		newChannelSaving = true;
		try {
			const res = await fetch('/api/channels', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name: newChannelName.trim(), description: newChannelDesc.trim() || null, agent_ids: [] })
			});
			if (res.ok) { newChannelMode = false; await loadChannels(); await Promise.all([loadAllChannelMembers(), loadAllChannelDetails()]); }
		} finally { newChannelSaving = false; }
	}



	async function saveInlineEdit(chId: string) {
		if (!inlineEditName.trim()) return;
		inlineEditSaving = true;
		try {
			const res = await fetch(`/api/channels/${chId}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name: inlineEditName.trim(), description: inlineEditDesc.trim() || null })
			});
			if (res.ok) { inlineEditChannelId = null; await loadChannels(); await loadAllChannelMembers(); }
		} finally { inlineEditSaving = false; }
	}

	async function archiveChannel(ch: (typeof channels)[0]) {
		if (!confirm(`Archive "#${ch.name}"? Past messages remain accessible.`)) return;
		const res = await fetch(`/api/channels/${ch.id}`, { method: 'DELETE' });
		if (res.ok) {
			if (selected === ch.id) selected = 'channels';
			await loadChannels();
		}
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

	// Inline per-channel settings helpers (Channels pane)
	async function loadAllChannelDetails() {
		await Promise.all(channels.map(async (ch) => {
			const res = await fetch(`/api/settings?channelId=${encodeURIComponent(ch.id)}`);
			if (!res.ok) return;
			const data = await res.json();
			const detail = data.channel as ChannelSettings;
			channelDetailsMap = { ...channelDetailsMap, [ch.id]: detail };
			channelEditsMap = { ...channelEditsMap, [ch.id]: {
				budgetText: detail.kbBudgetOverride?.toString() ?? '',
				autoApprove: detail.autoApprove,
				roundtripText: detail.roundtripCapOverride?.toString() ?? '',
				saving: false
			}};
		}));
	}

	function patchChannelEdit(chId: string, patch: Partial<ChEdit>) {
		channelEditsMap = { ...channelEditsMap, [chId]: { ...channelEditsMap[chId], ...patch } };
	}

	async function saveChannelInline(chId: string) {
		const ed = channelEditsMap[chId];
		if (!ed || !global) return;
		patchChannelEdit(chId, { saving: true });
		const body: Record<string, unknown> = { autoApprove: ed.autoApprove };
		body.kbBudgetOverride = ed.budgetText.trim() === '' ? null : parseInt(ed.budgetText, 10);
		body.roundtripCapOverride = ed.roundtripText.trim() === '' ? null : parseInt(ed.roundtripText, 10);
		const res = await fetch(`/api/settings/channel/${encodeURIComponent(chId)}`, {
			method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
		});
		patchChannelEdit(chId, { saving: false });
		if (!res.ok) saveError = `Save failed: ${res.status}`;
	}

	async function addAgentToChannelCard(agentId: string, channelId: string) {
		const res = await fetch(`/api/channels/${channelId}/members`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ agent_id: agentId })
		});
		if (res.ok) await loadAllChannelMembers();
	}

	async function removeAgentFromChannelCard(agentId: string, channelId: string) {
		const res = await fetch(`/api/channels/${channelId}/members/${agentId}`, { method: 'DELETE' });
		if (res.ok) await loadAllChannelMembers();
	}

	async function resetChannelInline(chId: string) {
		if (!confirm('Reset all per-channel overrides?')) return;
		const res = await fetch(`/api/settings/channel/${encodeURIComponent(chId)}`, { method: 'DELETE' });
		if (!res.ok) { saveError = `Reset failed: ${res.status}`; return; }
		await loadAllChannelDetails();
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

	/**
	 * Connect (or reconnect) the WS used for cross-tab live refresh. Same
	 * path as the main app's WS; we only listen for the settings/agents/
	 * channels entities, everything else is ignored.
	 *
	 * Previously had no `onclose`/`onerror` at all — a dropped connection
	 * silently stopped delivering live updates forever, with no retry and
	 * no indicator. See issue #217 / U4.
	 */
	function connectWs() {
		const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		const url = `${proto}//${window.location.host}/ws`;
		let socket: WebSocket;
		try {
			socket = new WebSocket(url);
		} catch {
			scheduleWsReconnect();
			return;
		}
		ws = socket;
		socket.onopen = () => {
			wsReconnectAttempt = 0;
		};
		socket.onclose = () => {
			ws = null;
			scheduleWsReconnect();
		};
		ws.onmessage = async (ev) => {
			let msg: WSStateChanged;
			try {
				msg = JSON.parse(ev.data);
			} catch {
				return;
			}
			if (msg.type !== 'state_changed') return;
			if (msg.entity === 'agent') { await loadAgents(); return; }
			if (msg.entity === 'channel' || msg.entity === 'channel_member') {
				await loadChannels();
				await Promise.all([loadAllAgentChannels(), loadAllChannelMembers(), loadAllChannelDetails()]);
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

	function scheduleWsReconnect() {
		if (wsStopped) return;
		wsReconnectAttempt += 1;
		const delayMs = Math.min(1000 * 2 ** (wsReconnectAttempt - 1), 15000);
		wsReconnectTimer = setTimeout(connectWs, delayMs);
	}

	// selected is now always 'global' | 'agents' | 'channels'
	$effect(() => {
		channelDetail = null;
		editChannel = null;
	});

	onMount(async () => {
		await Promise.all([loadGlobal(), loadChannels(), loadAgents()]);
		// These all need channels to be loaded first
		await Promise.all([loadAllAgentChannels(), loadAllChannelMembers(), loadAllChannelDetails()]);
		if (global) applyThemeToHtml(global.theme);
		listenSystemTheme();
		const hash = window.location.hash.replace(/^#/, '');
		if (hash === 'agents') selected = 'agents';
		else if (hash === 'channels') selected = 'channels';
		// #channelId links (from nav gear) now route to Channels pane
		else if (hash && channels.some((c) => c.id === hash)) selected = 'channels';
		window.addEventListener('hashchange', onHashChange);
		connectWs();
	});

	function onHashChange() {
		const hash = window.location.hash.replace(/^#/, '');
		if (hash === 'agents') selected = 'agents';
		else if (hash === 'channels') selected = 'channels';
		else selected = 'global';
	}

	onDestroy(() => {
		wsStopped = true;
		if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
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


{#snippet agentEditFields(d: AgentDraft, patch: (p: Partial<AgentDraft>) => void)}
	<div class="agent-edit-section">
		<div class="field">
			<label for="ae-name">Name</label>
			<input id="ae-name" type="text" value={d.name} oninput={(e) => patch({ name: (e.target as HTMLInputElement).value })} placeholder="agent-name" required maxlength="80" />
		</div>
		<div class="field">
			<label for="ae-type">Connector type</label>
			<select id="ae-type" value={d.connectorType} onchange={(e) => patch({ connectorType: (e.target as HTMLSelectElement).value as 'openclaw' | 'openai-compatible' | 'anthropic-stub' })}>
				<option value="openclaw">openclaw</option>
				<option value="openai-compatible">openai-compatible</option>
				<option value="anthropic-stub">anthropic-stub</option>
			</select>
		</div>
		{#if d.connectorType === 'openclaw'}
			<div class="field">
				<label for="ae-oc-url">Base URL</label>
				<input id="ae-oc-url" type="text" value={d.openclawBaseUrl} oninput={(e) => patch({ openclawBaseUrl: (e.target as HTMLInputElement).value })} />
			</div>
			<div class="field">
				<label for="ae-oc-tok">Token env var</label>
				<input id="ae-oc-tok" type="text" value={d.openclawTokenEnvVar} oninput={(e) => patch({ openclawTokenEnvVar: (e.target as HTMLInputElement).value })} />
			</div>
			<div class="field">
				<label for="ae-oc-model">Model</label>
				<input id="ae-oc-model" type="text" value={d.openclawModel} oninput={(e) => patch({ openclawModel: (e.target as HTMLInputElement).value })} />
			</div>
			<div class="field">
				<label for="ae-oc-sess">Session override</label>
				<input id="ae-oc-sess" type="text" value={d.openclawSessionOverride} oninput={(e) => patch({ openclawSessionOverride: (e.target as HTMLInputElement).value })} placeholder="optional" />
			</div>
		{:else if d.connectorType === 'openai-compatible'}
			<div class="field">
				<label for="ae-oai-url">Base URL</label>
				<input id="ae-oai-url" type="text" value={d.oaiCompatBaseUrl} oninput={(e) => patch({ oaiCompatBaseUrl: (e.target as HTMLInputElement).value })} />
			</div>
			<div class="field">
				<label for="ae-oai-tok">Token env var</label>
				<input id="ae-oai-tok" type="text" value={d.oaiCompatTokenEnvVar} oninput={(e) => patch({ oaiCompatTokenEnvVar: (e.target as HTMLInputElement).value })} />
			</div>
			<div class="field">
				<label for="ae-oai-hint">Model hint</label>
				<input id="ae-oai-hint" type="text" value={d.oaiCompatModelHint} oninput={(e) => patch({ oaiCompatModelHint: (e.target as HTMLInputElement).value })} />
			</div>
		{:else}
			<div class="field">
				<label for="ae-stub-persona">Persona</label>
				<input id="ae-stub-persona" type="text" value={d.stubPersona} oninput={(e) => patch({ stubPersona: (e.target as HTMLInputElement).value })} />
			</div>
			<div class="field">
				<label for="ae-stub-replies">Replies (one per line)</label>
				<textarea id="ae-stub-replies" rows="3" value={d.stubRepliesText} oninput={(e) => patch({ stubRepliesText: (e.target as HTMLTextAreaElement).value })}></textarea>
			</div>
		{/if}
	</div>
{/snippet}

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
			<button
				type="button"
				class:active={selected === 'agents'}
				onclick={() => (selected = 'agents')}
			>
				Agents
			</button>
			<button
				type="button"
				class:active={selected === 'channels'}
				onclick={() => (selected = 'channels')}
			>
				Channels
			</button>
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
		{/if}


		{#if selected === 'agents'}
			<div class="agent-toolbar">
				<button type="button" class="primary" onclick={() => { newAgentMode = !newAgentMode; newAgentDraft = freshDraft(); }}>
					{newAgentMode ? '✕ Cancel' : '+ New Agent'}
				</button>
				<button type="button" onclick={triggerLoadAgent} title="Import from JSON file">⇧ Upload</button>
				<input bind:this={loadAgentInput} type="file" accept="application/json,.json" style="display:none" onchange={onLoadAgentFile} />
			</div>

			{#if newAgentMode}
				<div class="agent-card expanded-card">
					{@render agentEditFields(newAgentDraft, (p) => newAgentDraft = { ...newAgentDraft, ...p })}
					<div class="expand-actions">
						<button type="button" class="primary" onclick={saveNewAgent} disabled={newAgentDraft.saving || !newAgentDraft.name.trim()}>
							{newAgentDraft.saving ? 'Creating…' : 'Create Agent'}
						</button>
						<button type="button" onclick={() => newAgentMode = false}>Cancel</button>
						{#if newAgentDraft.error}<span class="inline-error">{newAgentDraft.error}</span>{/if}
					</div>
				</div>
			{/if}

			{#if agentsLoading}
				<p class="note">Loading…</p>
			{:else if agentsList.length === 0 && !newAgentMode}
				<p class="note empty">No agents yet.</p>
			{:else}
				<div class="agent-list">
					{#each agentsList as agent (agent.id)}
						<div class="agent-card" class:expanded-card={expandedAgentId === agent.id}>
							<!-- Collapsed header — always visible -->
							<div class="agent-card-header">
								<div class="agent-info">
									<span class="dot" class:disabled={!agent.enabled}></span>
									<span class="agent-name">{agent.name}</span>
									<span class="agent-type">{agent.connectorType}</span>
								</div>
								<div class="agent-card-actions">
									<!-- Overflow actions (non-primary) -->
									<button type="button" class="icon-btn" onclick={() => saveAgentToFile(agent)} title="Export to JSON">⇩</button>
									<button type="button" class="icon-btn danger-icon" onclick={() => archiveAgent(agent)} title="Archive">🗑</button>
									<button
										type="button" class="chevron-btn"
										onclick={() => expandAgent(agent)}
										title={expandedAgentId === agent.id ? 'Collapse' : 'Edit'}
									>
										{expandedAgentId === agent.id ? '▲' : '▼'}
									</button>
								</div>
							</div>
							<!-- Channel chips — always visible -->
							<div class="agent-channels">
								{#each (agentChannels[agent.id] ?? []) as ch (ch.id)}
									<span class="channel-chip">#{ch.name}
										<button type="button" class="chip-remove" onclick={() => removeAgentFromChannel(agent.id, ch.id)}>×</button>
									</span>
								{/each}
								<select class="add-channel-select"
									onchange={(e) => { const v = (e.target as HTMLSelectElement).value; if (v) addAgentToChannel(agent.id, v); (e.target as HTMLSelectElement).value = ''; }}>
									<option value="">+ Add to channel…</option>
									{#each channels.filter(ch => !(agentChannels[agent.id] ?? []).some(m => m.id === ch.id)) as ch (ch.id)}
										<option value={ch.id}>#{ch.name}</option>
									{/each}
								</select>
							</div>
							<!-- Expanded edit area -->
							{#if expandedAgentId === agent.id && agentDrafts[agent.id]}
								{@const d = agentDrafts[agent.id]}
								{@render agentEditFields(d, (p) => patchDraft(agent.id, p))}
								<div class="expand-actions">
									<button type="button" class="primary" onclick={() => saveAgentDraft(agent.id)} disabled={d.saving || !d.name.trim()}>
										{d.saving ? 'Saving…' : 'Save'}
									</button>
									<button type="button" onclick={() => toggleAgentEnabled(agent)}>{agent.enabled ? 'Disable' : 'Enable'}</button>
									<button type="button" onclick={() => expandedAgentId = null}>Cancel</button>
									{#if d.error}<span class="inline-error">{d.error}</span>{/if}
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		{/if}

		{#if selected === 'channels'}
			<div class="agent-toolbar">
				<button type="button" class="primary" onclick={() => { newChannelMode = true; newChannelName = ''; newChannelDesc = ''; }}>
					+ New Channel
				</button>
			</div>

			{#if newChannelMode}
				<div class="agent-card new-channel-form">
					<div class="inline-edit-header">
						<div class="inline-edit-fields">
							<input class="inline-name-input" type="text" bind:value={newChannelName}
								placeholder="Channel name"
								onkeydown={(e) => { if (e.key === 'Enter') saveNewChannel(); if (e.key === 'Escape') newChannelMode = false; }}
							/>
							<input class="inline-desc-input" type="text" bind:value={newChannelDesc}
								placeholder="Description (optional)"
								onkeydown={(e) => { if (e.key === 'Enter') saveNewChannel(); if (e.key === 'Escape') newChannelMode = false; }}
							/>
						</div>
						<div class="agent-row-actions">
							<button type="button" onclick={saveNewChannel} disabled={newChannelSaving}>{newChannelSaving ? '…' : 'Create'}</button>
							<button type="button" onclick={() => newChannelMode = false}>Cancel</button>
						</div>
					</div>
				</div>
			{/if}

			{#if channels.length === 0}
				<p class="note empty">No channels yet.</p>
			{:else}
				<div class="agent-list">
					{#each channels as ch (ch.id)}
						<div class="agent-card">
							{#if inlineEditChannelId === ch.id}
								<div class="inline-edit-header">
									<div class="inline-edit-fields">
										<input class="inline-name-input" type="text" bind:value={inlineEditName}
											placeholder="Channel name"
											onkeydown={(e) => { if (e.key === 'Enter') saveInlineEdit(ch.id); if (e.key === 'Escape') cancelInlineEdit(); }}
										/>
										<input class="inline-desc-input" type="text" bind:value={inlineEditDesc}
											placeholder="Description (optional)"
											onkeydown={(e) => { if (e.key === 'Enter') saveInlineEdit(ch.id); if (e.key === 'Escape') cancelInlineEdit(); }}
										/>
									</div>
									<div class="agent-row-actions">
										<button type="button" onclick={() => saveInlineEdit(ch.id)} disabled={inlineEditSaving}>{inlineEditSaving ? '…' : 'Save'}</button>
										<button type="button" onclick={cancelInlineEdit}>Cancel</button>
									</div>
								</div>
							{:else}
								<div class="agent-card-header">
									<div class="agent-info">
										<span class="dot"></span>
										<span class="agent-name">#{ch.name}</span>
										{#if ch.description}<span class="agent-type">{ch.description}</span>{/if}
									</div>
									<div class="agent-row-actions">
										<button type="button" onclick={() => startInlineEdit(ch)}>Edit</button>
										<button type="button" class="danger" onclick={() => archiveChannel(ch)}>Archive</button>
									</div>
								</div>
							{/if}
							<div class="agent-channels">
								<span class="channels-label">Agents:</span>
								{#each (channelMemberMap[ch.id] ?? []) as m (m.id)}
									<span class="channel-chip">
										{m.name}
										<button type="button" class="chip-remove"
											onclick={() => removeAgentFromChannelCard(m.id, ch.id)}
											title="Remove {m.name}">×</button>
									</span>
								{:else}
									<span class="channels-label" style="font-style:italic">none</span>
								{/each}
								<select
									class="add-channel-select"
									onchange={(e) => {
										const agentId = (e.target as HTMLSelectElement).value;
										if (agentId) addAgentToChannelCard(agentId, ch.id);
										(e.target as HTMLSelectElement).value = '';
									}}
								>
									<option value="">+ Add agent…</option>
									{#each agentsList.filter(a => !(channelMemberMap[ch.id] ?? []).some(m => m.id === a.id)) as a (a.id)}
										<option value={a.id}>{a.name}</option>
									{/each}
								</select>
							</div>
							{#if channelEditsMap[ch.id] && channelDetailsMap[ch.id] && global}
								{@const ed = channelEditsMap[ch.id]}
								{@const det = channelDetailsMap[ch.id]}
								<div class="ch-settings-form">
									<div class="field">
										<label for="kb-{ch.id}">KB budget override</label>
										<input id="kb-{ch.id}" type="number" min="1" max="100000" step="1"
											placeholder="inherit ({global.kbBudgetDefault})"
											value={ed.budgetText}
											oninput={(e) => patchChannelEdit(ch.id, { budgetText: (e.target as HTMLInputElement).value })}
											onblur={() => saveChannelInline(ch.id)}
										/>
										<span class="unit">KB</span>
										<span class="hint">Empty = inherit global ({global.kbBudgetDefault} KB)</span>
									</div>
									<div class="field">
										<label for="aa-{ch.id}">Auto-approve agent mentions</label>
										<input id="aa-{ch.id}" type="checkbox" checked={ed.autoApprove}
											onchange={(e) => { patchChannelEdit(ch.id, { autoApprove: (e.target as HTMLInputElement).checked }); saveChannelInline(ch.id); }}
										/>
										<span class="hint">Skip approval queue for agent→agent mentions</span>
									</div>
									<div class="field">
										<label for="rc-{ch.id}">Roundtrip cap override</label>
										<input id="rc-{ch.id}" type="number" min="1" max="100" step="1"
											placeholder="inherit ({global.roundtripCapDefault})"
											value={ed.roundtripText}
											oninput={(e) => patchChannelEdit(ch.id, { roundtripText: (e.target as HTMLInputElement).value })}
											onblur={() => saveChannelInline(ch.id)}
										/>
										<span class="unit">hops</span>
										<span class="hint">Empty = inherit global ({global.roundtripCapDefault})</span>
									</div>
									<div class="ch-settings-footer">
										{#if ed.saving}<span class="saving-label">Saving…</span>{/if}
										<button type="button" class="reset-link" onclick={() => resetChannelInline(ch.id)}>Reset to global</button>
									</div>
								</div>
							{/if}
						</div>
					{/each}
				</div>
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
		height: 100vh;
		overflow: hidden;
	}

	.rail {
		border-right: 1px solid var(--finn-border);
		padding: var(--finn-space-4);
		background: var(--finn-bg-elevated);
		overflow-y: auto;
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
		padding: 1.25rem 1.5rem;
		overflow-y: auto;
		min-height: 0;
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
	/* Inline name/description editing */
	.inline-edit-header {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding: 0.6rem 0.85rem;
	}
	.inline-edit-fields { display: flex; flex-direction: column; gap: 0.3rem; flex: 1; min-width: 0; }
	.inline-name-input {
		background: var(--finn-bg-input);
		border: 1px solid var(--finn-accent);
		color: var(--finn-text-primary);
		padding: 0.25rem 0.5rem;
		font-family: inherit;
		font-size: var(--finn-text-sm);
		font-weight: 600;
		border-radius: var(--finn-radius-sm);
		width: 100%;
	}
	.inline-desc-input {
		background: var(--finn-bg-input);
		border: 1px solid var(--finn-border);
		color: var(--finn-text-secondary);
		padding: 0.2rem 0.5rem;
		font-family: inherit;
		font-size: var(--finn-text-xs);
		border-radius: var(--finn-radius-sm);
		width: 100%;
	}
	.inline-name-input:focus, .inline-desc-input:focus { outline: none; border-color: var(--finn-accent); }

	/* Inline channel settings — auto-saves on blur/change, no Save button */
	.ch-settings-form {
		padding: 0.6rem 0.85rem;
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.5rem 1rem;
		border-top: 1px solid var(--finn-border);
		font-family: var(--finn-font-sans);
		font-size: var(--finn-text-xs);
	}
	.ch-settings-form .field {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}
	.ch-settings-form label {
		color: var(--finn-text-muted);
		font-size: var(--finn-text-xs);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.ch-settings-form input[type="number"] {
		background: var(--finn-bg-input);
		border: 1px solid var(--finn-border);
		color: var(--finn-text-primary);
		border-radius: var(--finn-radius-sm);
		padding: 0.2rem 0.4rem;
		font-family: inherit;
		font-size: var(--finn-text-xs);
		width: 8rem;
		transition: border-color var(--finn-transition-fast);
	}
	.ch-settings-form input[type="number"]:focus {
		outline: none;
		border-color: var(--finn-accent);
	}
	.ch-settings-form .hint {
		color: var(--finn-text-disabled);
		font-size: 0.7rem;
	}
	.ch-settings-form .unit {
		color: var(--finn-text-muted);
		font-size: var(--finn-text-xs);
	}
	.ch-settings-footer {
		grid-column: 1 / -1;
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding-top: 0.25rem;
	}
	.saving-label {
		font-size: var(--finn-text-xs);
		color: var(--finn-text-muted);
		font-style: italic;
	}
	.reset-link {
		background: transparent;
		border: none;
		color: var(--finn-text-muted);
		font-size: var(--finn-text-xs);
		cursor: pointer;
		padding: 0;
		text-decoration: underline;
		transition: color var(--finn-transition-fast);
	}
	.reset-link:hover { color: var(--finn-error); }

	.note.empty {
		font-style: italic;
		color: var(--finn-text-muted);
	}

	/* ── Expand/collapse agent cards ──────────────────────────────────── */
	.expanded-card {
		border-color: var(--finn-accent-glow);
	}
	.agent-card-actions {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}
	.chevron-btn {
		background: transparent;
		border: 1px solid var(--finn-border);
		color: var(--finn-text-muted);
		padding: 0.2rem 0.5rem;
		border-radius: var(--finn-radius-sm);
		cursor: pointer;
		font-size: var(--finn-text-xs);
		transition: all var(--finn-transition-fast);
	}
	.chevron-btn:hover { background: var(--finn-bg-hover); color: var(--finn-text-primary); }
	.expanded-card .chevron-btn { background: var(--finn-accent-soft); color: var(--finn-accent-hover); border-color: var(--finn-accent-glow); }
	.icon-btn {
		background: transparent;
		border: none;
		color: var(--finn-text-muted);
		padding: 0.2rem 0.3rem;
		cursor: pointer;
		font-size: 0.85rem;
		transition: color var(--finn-transition-fast);
	}
	.icon-btn:hover { color: var(--finn-text-secondary); }
	.danger-icon:hover { color: var(--finn-error); }
	.agent-edit-section {
		padding: 0.75rem 0.85rem;
		border-top: 1px solid var(--finn-border);
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		background: var(--finn-bg-base);
	}
	.expand-actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.85rem;
		border-top: 1px solid var(--finn-border);
		background: var(--finn-bg-elevated);
	}
	.expand-actions .primary {
		background: var(--finn-accent);
		border-color: var(--finn-accent);
		color: #fff;
		font-weight: 500;
	}
	.expand-actions .primary:hover:not(:disabled) {
		background: var(--finn-accent-hover);
		box-shadow: var(--finn-shadow-glow);
	}
	.inline-error {
		color: var(--finn-error);
		font-size: var(--finn-text-xs);
	}
</style>
