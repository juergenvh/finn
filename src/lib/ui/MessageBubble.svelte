<script lang="ts">
	import { tick } from 'svelte';
	import { renderMarkdown } from './markdown';
	import type { AgentInfo, ApprovalSnapshot, TokenUsage } from './types';

	type Props = {
		sender: 'user' | 'agent' | 'system';
		senderName: string;
		body: string;
		ts: number;
		/** True while the agent reply is mid-stream (between
		 * `message_start` and `message_end`, ADR-0013). The bubble
		 * shows a blinking cursor at the body's tail while this is
		 * true. Default false for non-streaming senders (user, system,
		 * historical messages from initial load). */
		streaming?: boolean;
		/** Set when the upstream stream failed mid-flight
		 * (`message_error`). The bubble surfaces the error inline.
		 * Mutually exclusive with `streaming` (an errored bubble is
		 * no longer in flight). */
		error?: string | null;
		/** Token-usage counters for agent replies (issue #43 part B).
		 * Renders as a small footer line under the body when set;
		 * absent means no footer. Backends that don't surface usage
		 * (Wintermute today, anthropic-stub) keep this null. */
		tokens?: TokenUsage | null;
		approval?: ApprovalSnapshot;
		members: AgentInfo[];
		excludeAgentIds?: string[];
		hidden?: boolean;
		onDecide: (decision: 'approve' | 'reject', targets: string[], reason: string) => void;
		onSetHidden?: (hidden: boolean) => void;
		/**
		 * Optional: when set, the bubble offers a ↗ forward action
		 * in its hover-toolbar that opens an inline target picker.
		 * Confirming calls this with the chosen agent ids (must be
		 * channel members; the server filters defensively too).
		 * Issue #52. System messages do not get this affordance even
		 * if `onForward` is provided.
		 */
		onForward?: (targetAgentIds: string[]) => void;
	};

	let {
		sender,
		senderName,
		body,
		ts,
		streaming = false,
		error = null,
		tokens = null,
		approval,
		members,
		excludeAgentIds = [],
		hidden = false,
		onDecide,
		onSetHidden,
		onForward
	}: Props = $props();

	/* Forward-picker local state. The picker collapses back to
	 * the toolbar button when cancelled or after a successful
	 * forward; we don't need to persist anything across remounts. */
	let showForwardPicker = $state(false);
	let forwardTargets = $state<Set<string>>(new Set());

	function toggleForwardTarget(id: string) {
		const next = new Set(forwardTargets);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		forwardTargets = next;
	}

	/**
	 * Reference to this bubble's root element. Used to scroll the
	 * forward picker into view after it expands; without this the
	 * picker can land below the viewport for bubbles that sit
	 * higher in the channel (no length change in the message list,
	 * so the parent's auto-scroll effect doesn't fire).
	 */
	let bubbleEl: HTMLDivElement | null = $state(null);

	async function openForward() {
		forwardTargets = new Set();
		showForwardPicker = true;
		// Wait for the picker to render, then nudge the bubble into
		// the viewport. `block: 'end'` keeps the picker's confirm
		// button visible; for bubbles already fully on-screen the
		// browser is a no-op. Smooth so the motion is obvious to the
		// user (their click *is* what moved the page).
		await tick();
		bubbleEl?.scrollIntoView({ block: 'end', behavior: 'smooth' });
	}

	function confirmForward() {
		if (!onForward || forwardTargets.size === 0) return;
		onForward([...forwardTargets]);
		showForwardPicker = false;
		forwardTargets = new Set();
	}

	function cancelForward() {
		showForwardPicker = false;
		forwardTargets = new Set();
	}

	/* Forward is only offered for settled non-system messages and
	 * only when the parent provided the callback. Streaming bubbles
	 * are skipped because the row is not yet in the DB — the
	 * server's forward handler reads the body from there — and
	 * because the user almost certainly wants to forward the *full*
	 * reply, not a half-streamed fragment.
	 *
	 * Forward targets are the channel members, with no exclude
	 * filter — the user can even forward back to the original
	 * author if they really want to (rare, but no reason to block). */
	const forwardable = $derived(
		sender !== 'system' && !streaming && typeof onForward === 'function'
	);

	/* Markdown rendering (ADR-0016).
	 *
	 * Same pipeline for user and agent bubbles — the sanitizer is
	 * the safety control, not the source. System messages stay plain
	 * (finn-authored, no markdown to interpret).
	 *
	 * While streaming, we deliberately do NOT render markdown: the
	 * body is mid-construction, half-open code fences and dangling
	 * list markers would render badly. Plain text + cursor in that
	 * state matches ADR-0013's "plain-while-streaming, finalised on
	 * end" strategy. The markdown-finalisation is what triggers the
	 * ResizeObserver scroll discipline (handled in +page.svelte). */
	const renderedBody = $derived.by(() => {
		if (sender === 'system') return null;
		if (streaming) return null;
		if (!body) return '';
		return renderMarkdown(body, members);
	});

	/* Always-on footer for agent bubbles (ADR-0016 §9).
	 *
	 * Renders 'tokens: —' when the upstream did not surface usage,
	 * so the bubble shape stays consistent across backends. Hidden
	 * during streaming (usage arrives at message_end). User and
	 * system bubbles still have no footer. */
	const showFooter = $derived(sender === 'agent' && !streaming);
	const tokenTooltip = $derived(
		tokens
			? 'input → output tokens reported by the upstream backend'
			: 'this backend does not report usage'
	);

	/**
	 * Target selection for the approval picker, with a derived-with-
	 * override pattern to avoid the race condition that previously
	 * lost the original target list (issue #36).
	 *
	 * The previous implementation initialised `selectedTargets` to
	 * an empty Set and filled it from `approval.targets` in an
	 * `$effect`. Svelte 5 effects flush asynchronously in the
	 * microtask queue, so a sufficiently fast click on "Approve"
	 * — or a fresh `approval_created` arriving mid-mount — could
	 * fire the click against the still-empty Set, causing the
	 * server to write `targetedAgentIds: "[]"`, dispatch zero
	 * relays, and emit a `routed` approval with no targets. The
	 * UI then could not render the "routed to ..." sub-line
	 * because `targets.length > 0` was false.
	 *
	 * `effectiveTargets` derives synchronously from `approval.targets`,
	 * so the click always sees the canonical default. `userOverride`
	 * takes precedence only when the user actively toggles, so manual
	 * deselection still works.
	 */
	let userOverride = $state<Set<string> | null>(null);
	let rejectReason = $state('');
	let showRejectReason = $state(false);

	/** Reset the override when a different approval is bound to this
	 * bubble (e.g. on initial mount, or if the same component instance
	 * is reused for a different message). Without this, a user's
	 * deselection on one approval would persist visually onto the next. */
	let trackedApprovalId = '';
	$effect(() => {
		const id = approval?.id ?? '';
		if (id !== trackedApprovalId) {
			userOverride = null;
			trackedApprovalId = id;
		}
	});

	const effectiveTargets = $derived(
		userOverride ?? new Set(approval?.targets ?? [])
	);

	function toggleTarget(id: string) {
		const next = new Set(effectiveTargets);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		userOverride = next;
	}

	function approve() {
		onDecide('approve', [...effectiveTargets], '');
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

	/**
	 * Streaming-lifecycle indicator (issue #43 part A).
	 *
	 * Three mutually-exclusive states for an agent reply:
	 *   'streaming' — between message_start and message_end
	 *   'errored'   — message_error arrived
	 *   'done'      — settled (message_end arrived, or the row was
	 *                 loaded from the DB and is by definition
	 *                 complete)
	 *
	 * Only meaningful for agent bubbles. User and system messages
	 * are never streamed; they don't get an indicator.
	 */
	const streamingState = $derived<'streaming' | 'errored' | 'done' | null>(
		sender !== 'agent' ? null : streaming ? 'streaming' : error ? 'errored' : 'done'
	);
	const streamingIcon = $derived(
		streamingState === 'streaming'
			? '●'
			: streamingState === 'errored'
				? '⚠'
				: streamingState === 'done'
					? '✓'
					: ''
	);
	const streamingTitle = $derived(
		streamingState === 'streaming'
			? 'streaming…'
			: streamingState === 'errored'
				? `stream failed${error ? `: ${error}` : ''}`
				: streamingState === 'done'
					? 'message complete'
					: ''
	);
</script>

<div class="row {sender}">
	<div
		bind:this={bubbleEl}
		class="bubble {sender}"
		class:has-approval={!!approval}
		class:status-pending={statusBadge === 'pending'}
		class:status-approved={statusBadge === 'approved'}
		class:status-routed={statusBadge === 'routed'}
		class:status-rejected={statusBadge === 'rejected'}
		class:streaming
		class:errored={!!error}
		class:hidden-msg={hidden}
	>
		<div class="toolbar">
			{#if forwardable}
				<button
					class="toolbar-btn"
					title="forward this message to another agent"
					onclick={openForward}
					aria-label="forward"
				>
					↗
				</button>
			{/if}
			{#if onSetHidden}
				<button
					class="toolbar-btn"
					title={hidden ? 'unhide message' : 'hide message from this view'}
					onclick={() => onSetHidden(!hidden)}
					aria-label={hidden ? 'unhide' : 'hide'}
				>
					{hidden ? '↻' : '×'}
				</button>
			{/if}
		</div>
		{#if sender !== 'system'}
			<div class="header">
				<div class="header-main">
					<span class="who">{senderName}</span>
					<span class="ts">{fmtTs(ts)}</span>
					{#if streamingState}
						<span
							class="stream-icon stream-{streamingState}"
							title={streamingTitle}
							aria-label={streamingTitle}
						>{streamingIcon}</span>
					{/if}
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

		<div class="body" class:body-plain={renderedBody === null} class:body-rich={renderedBody !== null}>
			{#if renderedBody === null}
				<!-- system messages and streaming bubbles render plain -->
				{#if body}{body}{/if}{#if streaming}<span class="cursor" aria-hidden="true">▌</span>{/if}
			{:else}
				<!-- markdown-rendered bodies; sanitized via DOMPurify in markdown.ts -->
				{@html renderedBody}
			{/if}
		</div>
		{#if error}
			<div class="error-line" role="alert">
				<span class="error-icon" aria-hidden="true">⚠</span> stream failed: {error}
			</div>
		{/if}

		{#if showFooter}
			<!--
				Always-on footer for agent bubbles (ADR-0016 §9). Hosts
				per-message metadata; renders 'tokens: —' when the
				backend doesn't report usage so the bubble shape stays
				consistent. Future tenants (model name, latency, relay
				path) plug in alongside without further restructuring.

				Hidden while streaming — usage arrives at message_end,
				never mid-stream.
			-->
			<div class="footer" aria-label="message metadata">
				<span class="footer-item" title={tokenTooltip}>
					{#if tokens}
						tokens: {tokens.total}
						<span class="tokens-detail">(<span class="tok-arrow" aria-label="input">↓</span>{tokens.input}, <span class="tok-arrow" aria-label="output">↑</span>{tokens.output})</span>
					{:else}
						tokens: <span class="tokens-detail">—</span>
					{/if}
				</span>
			</div>
		{/if}

		{#if showForwardPicker}
			<!--
				Inline forward picker. Visually mirrors the approval
				picker below — same checkbox-chip layout — but the
				action is single-step (no human-in-the-loop on the
				relay; the user's confirm click *is* the approval per
				issue #52 / ADR-0005 reasoning).
			-->
			<div class="approval forward-picker">
				<div class="targets">
					<span class="lbl">forward to:</span>
					{#each members as m (m.id)}
						<label class="target">
							<input
								type="checkbox"
								checked={forwardTargets.has(m.id)}
								onchange={() => toggleForwardTarget(m.id)}
							/>
							{m.name}
						</label>
					{/each}
					{#if members.length === 0}
						<span class="empty">no agents in this channel</span>
					{/if}
				</div>
				<div class="actions">
					<button
						class="approve"
						onclick={confirmForward}
						disabled={forwardTargets.size === 0}
					>
						forward → {forwardTargets.size} target{forwardTargets.size === 1 ? '' : 's'}
					</button>
					<button onclick={cancelForward}>cancel</button>
				</div>
			</div>
		{/if}

		{#if approval && approval.status === 'pending'}
			<div class="approval">
				<div class="targets">
					<span class="lbl">deliver to:</span>
					{#each selectableMembers as m (m.id)}
						<label class="target">
							<input
								type="checkbox"
								checked={effectiveTargets.has(m.id)}
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
						<button class="approve" onclick={approve} disabled={effectiveTargets.size === 0}>
							approve → {effectiveTargets.size} target{effectiveTargets.size === 1 ? '' : 's'}
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
		position: relative;
		max-width: 80%;
		padding: 0.55rem 0.75rem;
		border-radius: 10px;
		border-left: 3px solid transparent;
	}
	.bubble.hidden-msg {
		opacity: 0.45;
		border-left-color: #475569;
		border-left-style: dashed;
	}
	.toolbar {
		position: absolute;
		top: 0.2rem;
		right: 0.3rem;
		display: flex;
		gap: 0.1rem;
		opacity: 0;
		transition: opacity 120ms;
	}
	.bubble:hover .toolbar,
	.bubble.hidden-msg .toolbar {
		opacity: 1;
	}
	.toolbar-btn {
		background: transparent;
		border: 0;
		color: #475569;
		font-size: 0.9rem;
		line-height: 1;
		cursor: pointer;
		padding: 0.1rem 0.35rem;
		border-radius: 3px;
	}
	.toolbar-btn:hover {
		color: #cbd5e1;
		background: rgba(255, 255, 255, 0.05);
	}

	/* The forward picker reuses .approval's layout entirely; no
	 * extra styling needed here — .forward-picker is just a hook
	 * for any future visual differentiation. */
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

	.bubble.streaming {
		/* Subtle in-flight cue beyond the cursor itself. The body's
		 * leftmost edge gets a faint accent so a streaming bubble
		 * is visually distinct from a settled one even while no new
		 * tokens are being appended. */
		border-left-color: #38bdf8;
	}
	.bubble.errored {
		border-left-color: #b91c1c;
		background: #1f1416;
	}

	.cursor {
		/* Inline tail-of-text cursor that blinks while a message is
		 * mid-stream. Width matches a monospace half-block so it
		 * doesn't reflow the body when streaming flips off. */
		display: inline-block;
		margin-left: 1px;
		color: #94a3b8;
		animation: cursor-blink 1.05s steps(2, end) infinite;
	}
	@keyframes cursor-blink {
		0%, 49% { opacity: 1; }
		50%, 100% { opacity: 0; }
	}

	.error-line {
		margin-top: 0.5rem;
		padding: 0.4rem 0.55rem;
		border-radius: 4px;
		background: #2a1416;
		color: #fecaca;
		font-size: 0.78rem;
		line-height: 1.4;
		display: flex;
		gap: 0.4rem;
		align-items: flex-start;
	}
	.error-icon {
		color: #fca5a5;
	}

	.footer {
		margin-top: 0.5rem;
		padding-top: 0.4rem;
		border-top: 1px solid rgba(255, 255, 255, 0.06);
		display: flex;
		flex-wrap: wrap;
		gap: 0 0.6rem;
		color: #64748b;
		font-size: 0.7rem;
		line-height: 1.4;
	}
	.footer-item {
		display: inline-flex;
		gap: 0.25rem;
		align-items: baseline;
	}
	.tokens-detail {
		color: #475569;
	}
	.tok-arrow {
		color: #475569;
		display: inline-block;
		width: 0.8em;
		text-align: center;
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
	.stream-icon {
		/* First of the right-aligned header group: takes the
		 * `margin-left: auto` so the icon and any following badge
		 * sit flush against the bubble's right edge. */
		margin-left: auto;
		font-size: 0.78rem;
		line-height: 1;
		/* Reserve a stable width so streaming → done → errored
		 * transitions don't reflow the rest of the header. */
		min-width: 0.9rem;
		text-align: center;
		cursor: default;
	}
	.stream-streaming {
		color: #38bdf8;
		animation: stream-pulse 1.4s ease-in-out infinite;
	}
	.stream-done {
		color: #475569;
	}
	.stream-errored {
		color: #fca5a5;
	}
	@keyframes stream-pulse {
		0%, 100% { opacity: 0.55; }
		50% { opacity: 1; }
	}

	.badge {
		/* Also `auto` so a badge alone (no preceding stream-icon, e.g.
		 * on user-authored messages with an approval somehow) still
		 * pushes right. When both stream-icon and badge are present,
		 * the icon's auto absorbs the free space and the badge sits
		 * flush to its right — the visual we want. */
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
		word-break: break-word;
		/* Conversation body in a console-leaning monospace stack.
		 * Header, approval controls, and system notices stay in the
		 * page's sans-serif voice on purpose — only the message
		 * content gets the terminal feel. ui-monospace picks the
		 * platform-native console font (SF Mono on macOS, Cascadia
		 * on Windows 11, etc.); the explicit fallbacks cover older
		 * browsers and Linux distros without a touched system. No
		 * webfonts, no network round-trip. */
		font-family:
			ui-monospace,
			SFMono-Regular,
			'SF Mono',
			Menlo,
			Monaco,
			'Cascadia Mono',
			'Cascadia Code',
			Consolas,
			'DejaVu Sans Mono',
			monospace;
		font-size: 0.8rem;
		line-height: 1.45;
	}

	/* Plain-text path: streaming bubbles and system messages.
	 * Preserves explicit newlines from the body string verbatim. */
	.body-plain {
		white-space: pre-wrap;
	}

	/* Rich-rendered path: post-markdown HTML. The renderer owns
	 * whitespace from here (single newlines became <br>, double
	 * became <p>); fenced code blocks get inner pre-whitespace
	 * via the global rules below.
	 *
	 * The `:global()` wrapper is required because the markdown
	 * pipeline injects elements via {@html}; Svelte's scoped
	 * style hashes never get applied to those nodes. The cost is
	 * that these selectors leak globally, but the .body-rich
	 * scope keeps each rule local enough not to collide with
	 * anything else on the page. */
	.body-rich :global(p) {
		margin: 0 0 0.5em;
	}
	.body-rich :global(p:last-child) {
		margin-bottom: 0;
	}
	.body-rich :global(strong) {
		font-weight: 700;
		color: #f1f5f9;
	}
	.body-rich :global(em) {
		font-style: italic;
	}
	.body-rich :global(del) {
		text-decoration: line-through;
		opacity: 0.7;
	}
	.body-rich :global(a) {
		color: #38bdf8;
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.body-rich :global(a:hover) {
		color: #7dd3fc;
	}

	/* Inline code: subtle background, no border. Matches the
	 * surrounding body monospace stack so the only visual cue is
	 * the background swatch. */
	.body-rich :global(code) {
		background: rgba(255, 255, 255, 0.06);
		padding: 0.05em 0.3em;
		border-radius: 3px;
		font-size: 0.95em;
	}

	/* Fenced code blocks: distinct background block, internal
	 * <pre> whitespace so multi-line code keeps its formatting,
	 * horizontal scroll for over-wide lines (no soft-wrap on code
	 * — wrapping a JSON line mid-string is misleading). */
	.body-rich :global(pre) {
		background: rgba(0, 0, 0, 0.35);
		padding: 0.55em 0.75em;
		border-radius: 5px;
		margin: 0.5em 0;
		overflow-x: auto;
		line-height: 1.4;
	}
	.body-rich :global(pre code) {
		background: transparent;
		padding: 0;
		border-radius: 0;
		white-space: pre;
		display: block;
	}

	.body-rich :global(ul),
	.body-rich :global(ol) {
		margin: 0.4em 0;
		padding-left: 1.4em;
	}
	.body-rich :global(li) {
		margin: 0.15em 0;
	}
	.body-rich :global(li > p) {
		/* Multi-paragraph list items: kill the default top-margin
		 * on the first <p> so the bullet aligns with text. */
		margin: 0 0 0.4em;
	}

	.body-rich :global(blockquote) {
		margin: 0.5em 0;
		padding: 0.1em 0.75em;
		border-left: 3px solid #475569;
		color: #cbd5e1;
		font-style: italic;
	}

	.body-rich :global(h1),
	.body-rich :global(h2),
	.body-rich :global(h3),
	.body-rich :global(h4),
	.body-rich :global(h5),
	.body-rich :global(h6) {
		margin: 0.5em 0 0.3em;
		font-weight: 600;
		color: #f1f5f9;
	}
	.body-rich :global(h1) { font-size: 1.15em; }
	.body-rich :global(h2) { font-size: 1.08em; }
	.body-rich :global(h3) { font-size: 1.0em;  }
	.body-rich :global(h4),
	.body-rich :global(h5),
	.body-rich :global(h6) { font-size: 0.95em; }

	.body-rich :global(table) {
		border-collapse: collapse;
		margin: 0.5em 0;
		font-size: 0.95em;
	}
	.body-rich :global(th),
	.body-rich :global(td) {
		border: 1px solid #2a2a30;
		padding: 0.25em 0.5em;
		text-align: left;
	}
	.body-rich :global(th) {
		background: rgba(255, 255, 255, 0.04);
		font-weight: 600;
	}
	.body-rich :global(hr) {
		border: 0;
		border-top: 1px solid #2a2a30;
		margin: 0.7em 0;
	}

	/* Mention spans (post-process from markdown.ts). Subtle
	 * accent colour matching the existing mention-popup style;
	 * no underline so they don't compete with regular markdown
	 * links. */
	.body-rich :global(span.mention) {
		color: #38bdf8;
		background: rgba(56, 189, 248, 0.12);
		padding: 0 0.25em;
		border-radius: 3px;
		font-weight: 500;
	}
	.body-rich :global(span.mention:hover) {
		background: rgba(56, 189, 248, 0.22);
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
