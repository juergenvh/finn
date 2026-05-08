<script lang="ts">
	type ConnectorType = 'openclaw' | 'openai-compatible' | 'anthropic-stub';

	export type AgentFormPayload = {
		mode: 'create' | 'edit';
		name: string;
		enabled: boolean;
		// Includes connector_type discriminator. On edit, the server
		// pins this to the existing value; we still send it for shape
		// consistency.
		config: Record<string, unknown>;
	};

	type Props = {
		mode: 'create' | 'edit';
		agent?: {
			id: string;
			name: string;
			connectorType: ConnectorType;
			enabled: boolean;
			config: Record<string, unknown>;
		};
		onSubmit: (data: AgentFormPayload) => Promise<void> | void;
		onCancel: () => void;
	};

	let { mode, agent, onSubmit, onCancel }: Props = $props();

	// Form-state. See ChannelForm.svelte for the rationale on the
	// `initializedFor` pattern: re-initialise from props only when the
	// inbound `agent` identity changes, so user edits are not stomped
	// on incidental re-renders.
	let name = $state('');
	let enabled = $state(true);
	let connectorType = $state<ConnectorType>('openclaw');
	let submitting = $state(false);
	let errorMsg = $state<string | null>(null);

	// Per-connector config fields. We keep one state object and read
	// only the fields belonging to the current connector type when
	// submitting, so switching back and forth (in create mode)
	// preserves previously-entered values.
	let openclawBaseUrl = $state('http://127.0.0.1:18789/v1');
	let openclawTokenEnvVar = $state('FINN_OPENCLAW_API_KEY');
	let openclawModel = $state('openclaw');
	let oaiCompatBaseUrl = $state('https://agent.example.com/v1');
	let oaiCompatTokenEnvVar = $state('FINN_OPENAI_COMPAT_API_KEY');
	let oaiCompatModelHint = $state('default');
	let stubPersona = $state('a generic assistant');
	let stubRepliesText = $state(
		['notiert.', 'interessant. @dixie?', 'ich bleibe skeptisch.'].join('\n')
	);

	let initializedFor = $state<string | null>(null);

	$effect(() => {
		const key = agent?.id ?? '__create__';
		if (initializedFor === key) return;
		const initialConfig = (agent?.config ?? {}) as Record<string, unknown>;
		name = agent?.name ?? '';
		enabled = agent?.enabled ?? true;
		connectorType = agent?.connectorType ?? 'openclaw';
		// openclaw / openai-compatible share base_url and token_env_var
		// shape but live in separate state so a user switching the
		// connector type in create-mode doesn't lose either entry.
		if (agent?.connectorType === 'openclaw') {
			openclawBaseUrl =
				(initialConfig.base_url as string | undefined) ?? 'http://127.0.0.1:18789/v1';
			openclawTokenEnvVar =
				(initialConfig.token_env_var as string | undefined) ?? 'FINN_OPENCLAW_API_KEY';
			openclawModel = (initialConfig.model as string | undefined) ?? 'openclaw';
		} else if (agent?.connectorType === 'openai-compatible') {
			oaiCompatBaseUrl =
				(initialConfig.base_url as string | undefined) ?? 'https://agent.example.com/v1';
			oaiCompatTokenEnvVar =
				(initialConfig.token_env_var as string | undefined) ?? 'FINN_OPENAI_COMPAT_API_KEY';
			oaiCompatModelHint = (initialConfig.model_hint as string | undefined) ?? 'default';
		}
		stubPersona = (initialConfig.persona as string | undefined) ?? 'a generic assistant';
		stubRepliesText = Array.isArray(initialConfig.replies)
			? (initialConfig.replies as string[]).join('\n')
			: ['notiert.', 'interessant. @dixie?', 'ich bleibe skeptisch.'].join('\n');
		initializedFor = key;
	});

	const canSubmit = $derived(name.trim().length > 0 && !submitting);

	function buildConfig(): Record<string, unknown> {
		if (connectorType === 'openclaw') {
			return {
				connector_type: 'openclaw',
				base_url: openclawBaseUrl.trim(),
				token_env_var: openclawTokenEnvVar.trim(),
				model: openclawModel.trim()
			};
		}
		if (connectorType === 'openai-compatible') {
			return {
				connector_type: 'openai-compatible',
				base_url: oaiCompatBaseUrl.trim(),
				token_env_var: oaiCompatTokenEnvVar.trim(),
				model_hint: oaiCompatModelHint.trim()
			};
		}
		const replies = stubRepliesText
			.split('\n')
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		return {
			connector_type: 'anthropic-stub',
			persona: stubPersona.trim(),
			replies
		};
	}

	async function submit() {
		if (!canSubmit) return;
		submitting = true;
		errorMsg = null;
		try {
			await onSubmit({
				mode,
				name: name.trim(),
				enabled,
				config: buildConfig()
			});
		} catch (err) {
			errorMsg = (err as Error).message;
		} finally {
			submitting = false;
		}
	}
</script>

<form onsubmit={(e) => { e.preventDefault(); void submit(); }}>
	<label>
		<span class="lbl">Name</span>
		<input bind:value={name} placeholder="agent-name" required maxlength="80" />
	</label>

	<label>
		<span class="lbl">Connector type</span>
		<select bind:value={connectorType} disabled={mode === 'edit'}>
			<option value="openclaw">openclaw</option>
			<option value="openai-compatible">openai-compatible (Wintermute, Open WebUI, vLLM, …)</option>
			<option value="anthropic-stub">anthropic-stub (canned replies)</option>
		</select>
		{#if mode === 'edit'}
			<span class="hint">connector_type is fixed after creation</span>
		{/if}
	</label>

	<label class="checkbox">
		<input type="checkbox" bind:checked={enabled} />
		<span>Enabled (disabled agents do not receive dispatched messages)</span>
	</label>

	{#if connectorType === 'openclaw'}
		<fieldset>
			<legend>OpenClaw configuration</legend>
			<label>
				<span class="lbl">Base URL</span>
				<input bind:value={openclawBaseUrl} placeholder="http://127.0.0.1:18789/v1" />
				<span class="hint">Gateway URL ending in /v1</span>
			</label>
			<label>
				<span class="lbl">Token env var</span>
				<input bind:value={openclawTokenEnvVar} placeholder="FINN_OPENCLAW_API_KEY" />
				<span class="hint">
					Name of the env var holding the bearer token. The token itself is read at
					connector-call time from <code>~/finn-data/secrets/.env</code>; never stored in the DB.
				</span>
			</label>
			<label>
				<span class="lbl">Model</span>
				<input bind:value={openclawModel} placeholder="openclaw" />
				<span class="hint">
					OpenClaw agent target. <code>openclaw</code> = default agent;
					<code>openclaw/&lt;agentId&gt;</code> for a specific one.
				</span>
			</label>
		</fieldset>
	{:else if connectorType === 'openai-compatible'}
		<fieldset>
			<legend>OpenAI-compatible configuration</legend>
			<label>
				<span class="lbl">Base URL</span>
				<input bind:value={oaiCompatBaseUrl} placeholder="https://agent.example.com/v1" />
				<span class="hint">
					Base URL ending in <code>/v1</code> (or whatever the backend's
					OpenAI-style root is). The connector appends <code>/chat/completions</code>.
				</span>
			</label>
			<label>
				<span class="lbl">Token env var</span>
				<input bind:value={oaiCompatTokenEnvVar} placeholder="FINN_OPENAI_COMPAT_API_KEY" />
				<span class="hint">
					Name of the env var holding the bearer token. The token itself is read at
					connector-call time from <code>~/finn-data/secrets/.env</code>; never stored in the DB.
					Use a backend-specific name (e.g. <code>FINN_WINTERMUTE_API_KEY</code>) when running
					more than one openai-compatible agent.
				</span>
			</label>
			<label>
				<span class="lbl">Model hint</span>
				<input bind:value={oaiCompatModelHint} placeholder="default" />
				<span class="hint">
					Value sent in the OpenAI <code>model</code> body field. Backends that
					ignore the field (e.g. Wintermute) work fine with <code>default</code>;
					backends that route on <code>model</code> need the backend-specific id.
				</span>
			</label>
		</fieldset>
	{:else}
		<fieldset>
			<legend>Anthropic-stub configuration</legend>
			<label>
				<span class="lbl">Persona</span>
				<input bind:value={stubPersona} placeholder="a generic assistant" />
			</label>
			<label>
				<span class="lbl">Replies (one per line, round-robin)</span>
				<textarea bind:value={stubRepliesText} rows="5"></textarea>
				<span class="hint">
					For exercising the multi-agent flow without a real API. Include
					<code>@&lt;agent-name&gt;</code> in at least one reply to trigger an approval.
				</span>
			</label>
		</fieldset>
	{/if}

	{#if errorMsg}
		<div class="error">{errorMsg}</div>
	{/if}

	<div class="actions">
		<button type="button" onclick={onCancel} disabled={submitting}>Cancel</button>
		<button type="submit" class="primary" disabled={!canSubmit}>
			{mode === 'create' ? 'Create agent' : 'Save changes'}
		</button>
	</div>
</form>

<style>
	form {
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
		min-width: 460px;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	label.checkbox {
		flex-direction: row;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.9rem;
	}
	.lbl {
		font-size: 0.75rem;
		color: #94a3b8;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}
	.hint {
		font-size: 0.75rem;
		color: #64748b;
		line-height: 1.3;
	}
	.hint :global(code) {
		background: #0e0e10;
		padding: 0.05rem 0.3rem;
		border-radius: 3px;
	}
	input, select, textarea {
		background: #0e0e10;
		border: 1px solid #2a2a30;
		color: #e8e8ea;
		padding: 0.45rem 0.55rem;
		font-family: inherit;
		font-size: 0.95rem;
		border-radius: 4px;
	}
	select:disabled {
		opacity: 0.6;
	}
	textarea {
		resize: vertical;
		font-family: inherit;
	}
	fieldset {
		border: 1px solid #2a2a30;
		border-radius: 4px;
		padding: 0.6rem 0.75rem 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}
	legend {
		font-size: 0.75rem;
		color: #94a3b8;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		padding: 0 0.4rem;
	}
	.error {
		background: #3a1a1a;
		color: #fca5a5;
		padding: 0.4rem 0.6rem;
		border-radius: 4px;
		font-size: 0.85rem;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}
	button {
		background: #2a2a30;
		color: #e8e8ea;
		border: 1px solid #3a3a42;
		padding: 0.4rem 0.85rem;
		font-family: inherit;
		font-size: 0.9rem;
		border-radius: 4px;
		cursor: pointer;
	}
	button.primary {
		background: #075985;
		border-color: #0284c7;
	}
	button:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
</style>
