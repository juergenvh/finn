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
		font-size: 0.75rem;
		color: #94a3b8;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}
	input, textarea {
		background: #0e0e10;
		border: 1px solid #2a2a30;
		color: #e8e8ea;
		padding: 0.45rem 0.55rem;
		font-family: inherit;
		font-size: 0.95rem;
		border-radius: 4px;
	}
	textarea {
		resize: vertical;
	}
	fieldset {
		border: 1px solid #2a2a30;
		border-radius: 4px;
		padding: 0.5rem 0.75rem;
	}
	legend {
		font-size: 0.75rem;
		color: #94a3b8;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		padding: 0 0.4rem;
	}
	.empty {
		color: #777;
		font-style: italic;
		font-size: 0.85rem;
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
