<script lang="ts">
	import type { AgentInfo, ApprovalSnapshot } from './types';

	type Props = {
		sender: 'user' | 'agent' | 'system';
		senderName: string;
		body: string;
		ts: number;
		approval?: ApprovalSnapshot;
		members: AgentInfo[];
		/** Agents that should NOT be selectable as targets (e.g. the
		 *  authoring agent itself, or the user). */
		excludeAgentIds?: string[];
		onDecide: (decision: 'approve' | 'reject', targets: string[], reason: string) => void;
	};

	let {
		sender,
		senderName,
		body,
		ts,
		approval,
		members,
		excludeAgentIds = [],
		onDecide
	}: Props = $props();

	let selectedTargets = $state<Set<string>>(new Set());
	let rejectReason = $state('');
	let showRejectReason = $state(false);

	// Initialize target selection from the approval's default targets.
	// Re-runs only if the approval id changes (so user edits don't get
	// stomped on as new server snapshots arrive).
	let initializedFor = '';
	$effect(() => {
		if (approval && approval.id !== initializedFor) {
			selectedTargets = new Set(approval.targets);
			initializedFor = approval.id;
		}
	});

	function toggleTarget(id: string) {
		const next = new Set(selectedTargets);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selectedTargets = next;
	}

	function approve() {
		onDecide('approve', [...selectedTargets], '');
	}

	function reject() {
		if (!showRejectReason) {
			showRejectReason = true;
			return;
		}
		onDecide('reject', [], rejectReason);
	}

	function cancelReject() {
		showRejectReason = false;
		rejectReason = '';
	}

	const selectableMembers = $derived(members.filter((m) => !excludeAgentIds.includes(m.id)));

	function nameOf(agentId: string): string {
		return members.find((m) => m.id === agentId)?.name ?? agentId;
	}

	function fmtTs(ms: number): string {
		const d = new Date(ms);
		return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}

	const statusBadge = $derived(approval?.status ?? null);
</script>

<div class="msg {sender}" class:has-approval={!!approval} class:status-pending={statusBadge === 'pending'} class:status-approved={statusBadge === 'approved'} class:status-routed={statusBadge === 'routed'} class:status-rejected={statusBadge === 'rejected'}>
	<div class="header">
		<span class="who">{senderName}</span>
		<span class="ts">{fmtTs(ts)}</span>
		{#if statusBadge}
			<span class="badge {statusBadge}">{statusBadge}</span>
		{/if}
	</div>

	<div class="body">{body}</div>

	{#if approval && approval.status === 'pending'}
		<div class="approval">
			<div class="targets">
				<span class="lbl">deliver to:</span>
				{#each selectableMembers as m (m.id)}
					<label class="target">
						<input
							type="checkbox"
							checked={selectedTargets.has(m.id)}
							onchange={() => toggleTarget(m.id)}
						/>
						{m.name}
					</label>
				{/each}
				{#if selectableMembers.length === 0}
					<span class="empty">no other agents in this channel</span>
				{/if}
			</div>

			{#if showRejectReason}
				<div class="reject-row">
					<input
						type="text"
						bind:value={rejectReason}
						placeholder="reject reason (optional)"
					/>
					<button onclick={reject}>confirm reject</button>
					<button onclick={cancelReject}>cancel</button>
				</div>
			{:else}
				<div class="actions">
					<button class="approve" onclick={approve} disabled={selectedTargets.size === 0}>
						approve → {selectedTargets.size} target{selectedTargets.size === 1 ? '' : 's'}
					</button>
					<button class="reject" onclick={reject}>reject</button>
				</div>
			{/if}
		</div>
	{:else if approval && approval.status === 'routed' && approval.targets.length > 0}
		<div class="approval-summary">
			✓ routed to {approval.targets.map(nameOf).join(', ')}
		</div>
	{:else if approval && approval.status === 'rejected'}
		<div class="approval-summary rejected">
			✗ rejected{approval.rejectReason ? `: "${approval.rejectReason}"` : ''}
		</div>
	{/if}
</div>

<style>
	.msg {
		padding: 0.55rem 0.75rem;
		border-radius: 6px;
		border-left: 3px solid transparent;
	}
	.msg.user {
		background: #1a2030;
	}
	.msg.agent {
		background: #1a2a1f;
	}
	.msg.system {
		background: transparent;
		color: #777;
		font-style: italic;
		font-size: 0.85rem;
	}

	.msg.status-pending {
		border-left-color: #f59e0b;
	}
	.msg.status-approved {
		border-left-color: #38bdf8;
	}
	.msg.status-routed {
		border-left-color: #6ee7b7;
	}
	.msg.status-rejected {
		border-left-color: #f87171;
		opacity: 0.75;
	}

	.header {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		margin-bottom: 0.25rem;
		font-size: 0.8rem;
	}
	.who {
		color: #cbd5e1;
		font-weight: 600;
		text-transform: lowercase;
	}
	.ts {
		color: #555;
		font-size: 0.75rem;
	}
	.badge {
		margin-left: auto;
		padding: 0.1rem 0.45rem;
		border-radius: 9999px;
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.badge.pending {
		background: #78350f;
		color: #fde68a;
	}
	.badge.approved {
		background: #075985;
		color: #bae6fd;
	}
	.badge.routed {
		background: #064e3b;
		color: #a7f3d0;
	}
	.badge.rejected {
		background: #7f1d1d;
		color: #fecaca;
	}

	.body {
		white-space: pre-wrap;
		word-break: break-word;
	}

	.approval {
		margin-top: 0.6rem;
		padding-top: 0.55rem;
		border-top: 1px dashed #2a2a30;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.targets {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 0.75rem;
		font-size: 0.85rem;
		align-items: center;
	}
	.lbl {
		color: #888;
		text-transform: uppercase;
		font-size: 0.7rem;
		letter-spacing: 0.05em;
	}
	.target {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		cursor: pointer;
	}
	.empty {
		color: #777;
		font-style: italic;
	}

	.actions {
		display: flex;
		gap: 0.5rem;
	}
	button {
		background: #2a2a30;
		color: #e8e8ea;
		border: 1px solid #3a3a42;
		padding: 0.35rem 0.75rem;
		font-family: inherit;
		font-size: 0.85rem;
		border-radius: 4px;
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	button.approve {
		background: #075985;
		border-color: #0284c7;
	}
	button.reject {
		background: #7f1d1d;
		border-color: #b91c1c;
	}

	.reject-row {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}
	.reject-row input {
		flex: 1;
		background: #16161a;
		border: 1px solid #2a2a30;
		color: #e8e8ea;
		padding: 0.35rem 0.5rem;
		font-family: inherit;
		font-size: 0.9rem;
		border-radius: 4px;
	}

	.approval-summary {
		margin-top: 0.5rem;
		padding-top: 0.4rem;
		border-top: 1px dashed #2a2a30;
		font-size: 0.8rem;
		color: #6ee7b7;
	}
	.approval-summary.rejected {
		color: #f87171;
	}
</style>
