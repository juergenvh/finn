<script lang="ts">
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

	let name = $state(channel?.name ?? '');
	let description = $state(channel?.description ?? '');
	let selectedMembers = $state<Set<string>>(new Set(currentMemberIds));
	let submitting = $state(false);
	let errorMsg = $state<string | null>(null);

	function toggle(agentId: string) {
		const next = new Set(selectedMembers);
		if (next.has(agentId)) next.delete(agentId);
		else next.add(agentId);
		selectedMembers = next;
	}

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
			<div class="agents">
				{#each allAgents as a (a.id)}
					<label class="agent-row" class:disabled={!a.enabled}>
						<input
							type="checkbox"
							checked={selectedMembers.has(a.id)}
							onchange={() => toggle(a.id)}
						/>
						<span class="agent-name">{a.name}</span>
						<span class="agent-type">{a.connectorType}</span>
						{#if !a.enabled}<span class="agent-flag">disabled</span>{/if}
					</label>
				{/each}
			</div>
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
	.agents {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	.agent-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.9rem;
		padding: 0.2rem 0;
	}
	.agent-row.disabled {
		opacity: 0.55;
	}
	.agent-name {
		font-weight: 500;
	}
	.agent-type {
		color: #64748b;
		font-size: 0.75rem;
	}
	.agent-flag {
		color: #64748b;
		font-size: 0.7rem;
		text-transform: uppercase;
		margin-left: auto;
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
