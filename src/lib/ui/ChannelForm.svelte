<script lang="ts">
	import AgentChipInput from './AgentChipInput.svelte';
	import type { AgentInfo, ChannelInfo } from './types';

	type Props = {
		mode: 'create' | 'edit';
		channel?: ChannelInfo & { member_agent_ids?: string[] };
		allAgents: AgentInfo[];
		currentMemberIds?: string[];
		onSubmit: (data: ChannelFormPayload) => Promise<void> | void;
		onCancel: () => void;
	};

	export type ChannelFormPayload = {
		mode: 'create' | 'edit';
		name: string;
		description: string | null;
		// On create: full member list. On edit: ids to add and ids to remove.
		member_agent_ids?: string[];
		add_member_ids?: string[];
		remove_member_ids?: string[];
	};

	let { mode, channel, allAgents, currentMemberIds = [], onSubmit, onCancel }: Props = $props();

	// Form-state. Initialised from props on first render and whenever the
	// inbound channel identity changes (so opening the modal for a
	// different channel resets fields). The `initializedFor` sentinel
	// prevents user edits from being stomped on subsequent renders that
	// happen for unrelated reasons (e.g. a parent re-render).
	let name = $state('');
	let description = $state('');
	let selectedMembers = $state<Set<string>>(new Set());
	let submitting = $state(false);
	let errorMsg = $state<string | null>(null);
	let initializedFor = $state<string | null>(null);

	$effect(() => {
		const key = channel?.id ?? '__create__';
		if (initializedFor === key) return;
		name = channel?.name ?? '';
		description = channel?.description ?? '';
		selectedMembers = new Set(currentMemberIds);
		initializedFor = key;
	});

	const canSubmit = $derived(name.trim().length > 0 && !submitting);

	async function submit() {
		if (!canSubmit) return;
		submitting = true;
		errorMsg = null;
		try {
			if (mode === 'create') {
				await onSubmit({
					mode,
					name: name.trim(),
					description: description.trim() || null,
					member_agent_ids: [...selectedMembers]
				});
			} else {
				const before = new Set(currentMemberIds);
				const after = selectedMembers;
				const add_member_ids = [...after].filter((id) => !before.has(id));
				const remove_member_ids = [...before].filter((id) => !after.has(id));
				await onSubmit({
					mode,
					name: name.trim(),
					description: description.trim() || null,
					add_member_ids,
					remove_member_ids
				});
			}
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
		<input bind:value={name} placeholder="channel-name" required maxlength="80" />
	</label>

	<label>
		<span class="lbl">Description</span>
		<textarea bind:value={description} rows="2" maxlength="500" placeholder="optional"></textarea>
	</label>

	<fieldset>
		<legend>Members</legend>
		{#if allAgents.length === 0}
			<p class="empty">no agents to add — create one first.</p>
		{:else}
			<AgentChipInput
				{allAgents}
				value={selectedMembers}
				onChange={(next) => (selectedMembers = next)}
			/>
		{/if}
	</fieldset>

	{#if errorMsg}
		<div class="error">{errorMsg}</div>
	{/if}

	<div class="actions">
		<button type="button" onclick={onCancel} disabled={submitting}>Cancel</button>
		<button type="submit" class="primary" disabled={!canSubmit}>
			{mode === 'create' ? 'Create channel' : 'Save changes'}
		</button>
	</div>
</form>

<style>
	form {
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
		min-width: 420px;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.lbl {
		font-size: var(--finn-text-xs);
		color: var(--finn-text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		font-weight: 500;
	}
	input, textarea {
		background: var(--finn-bg-input);
		border: 1px solid var(--finn-border);
		color: var(--finn-text-primary);
		padding: 0.45rem 0.55rem;
		font-family: inherit;
		font-size: var(--finn-text-base);
		border-radius: var(--finn-radius-sm);
		transition: border-color var(--finn-transition-fast);
	}
	input:focus, textarea:focus {
		outline: none;
		border-color: var(--finn-accent);
	}
	textarea {
		resize: vertical;
	}
	fieldset {
		border: 1px solid var(--finn-border);
		border-radius: var(--finn-radius-sm);
		padding: 0.5rem 0.75rem;
	}
	legend {
		font-size: var(--finn-text-xs);
		color: var(--finn-text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		padding: 0 0.4rem;
	}
	.empty {
		color: var(--finn-text-muted);
		font-style: italic;
		font-size: var(--finn-text-sm);
	}
	.error {
		background: var(--finn-error-bg);
		color: var(--finn-error);
		padding: 0.4rem 0.6rem;
		border-radius: var(--finn-radius-sm);
		font-size: var(--finn-text-sm);
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}
	button {
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
	button:hover:not(:disabled) {
		background: var(--finn-bg-hover);
	}
	button.primary {
		background: var(--finn-accent);
		border-color: var(--finn-accent);
		color: #fff;
		font-weight: 500;
	}
	button.primary:hover:not(:disabled) {
		background: var(--finn-accent-hover);
		box-shadow: var(--finn-shadow-glow);
	}
	button:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
</style>
