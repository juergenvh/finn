<script lang="ts">
	import type { AgentInfo, ApprovalSnapshot } from './types';

	type Props = {
		sender: 'user' | 'agent' | 'system';
		senderName: string;
		body: string;
		ts: number;
		approval?: ApprovalSnapshot;
		members: AgentInfo[];
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

<div class="row {sender}">
	<div
		class="bubble {sender}"
		class:has-approval={!!approval}
		class:status-pending={statusBadge === 'pending'}
		class:status-approved={statusBadge === 'approved'}
		class:status-routed={statusBadge === 'routed'}
		class:status-rejected={statusBadge === 'rejected'}
	>
		{#if sender !== 'system'}
			<div class="header">
				<div class="header-main">
					<span class="who">{senderName}</span>
					<span class="ts">{fmtTs(ts)}</span>
					{#if statusBadge}
						<span class="badge {statusBadge}">{statusBadge}</span>
					{/if}
				</div>
				<!-- routing/meta sub-line: appears only when data is present.
				     for now this only renders for terminal approvals; future
				     additions (origin agent, relay path, etc.) plug in here. -->
				{#if approval && approval.status === 'routed' && approval.targets.length > 0}
					<div class="header-meta">
						routed to {approval.targets.map(nameOf).join(', ')}
					</div>
				{:else if approval && approval.status === 'rejected'}
					<div class="header-meta">
						rejected{approval.rejectReason ? `: "${approval.rejectReason}"` : ''}
					</div>
				{/if}
			</div>
		{/if}

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
		{/if}
	</div>
</div>

<style>
	.row {
		display: flex;
		width: 100%;
	}
	.row.user {
		justify-content: flex-end;
	}
	.row.agent {
		justify-content: flex-start;
	}
	.row.system {
		justify-content: center;
	}

	.bubble {
		max-width: 80%;
		padding: 0.55rem 0.75rem;
		border-radius: 10px;
		border-left: 3px solid transparent;
	}
	.bubble.user {
		background: #1e3a5f;
		border-top-right-radius: 2px;
	}
	.bubble.agent {
		background: #1f3a2a;
		border-top-left-radius: 2px;
	}
	.bubble.system {
		background: transparent;
		color: #777;
		font-style: italic;
		font-size: 0.85rem;
		max-width: 60%;
		text-align: center;
	}

	.bubble.status-pending {
		border-left-color: #f59e0b;
	}
	.bubble.status-approved {
		border-left-color: #38bdf8;
	}
	.bubble.status-routed {
		border-left-color: #6ee7b7;
	}
	.bubble.status-rejected {
		border-left-color: #7f1d1d;
		background: #1a1416;
		opacity: 0.6;
	}
	.bubble.status-rejected .body {
		color: #5a5a5e;
	}
	.bubble.status-rejected .who {
		color: #6b6b70;
	}

	.header {
		padding-bottom: 0.35rem;
		margin-bottom: 0.4rem;
		border-bottom: 1px solid rgba(255, 255, 255, 0.08);
	}
	.header-main {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		font-size: 0.8rem;
	}
	.header-meta {
		margin-top: 0.15rem;
		color: #64748b;
		font-size: 0.7rem;
		line-height: 1.3;
	}
	.who {
		color: #e2e8f0;
		font-weight: 600;
		text-transform: lowercase;
	}
	.ts {
		color: #64748b;
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
		color: #94a3b8;
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

</style>
