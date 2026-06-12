<script lang="ts">
	import { Carta, MarkdownEditor } from 'carta-md';
	import 'carta-md/default.css';
	import DOMPurify from 'dompurify';

	type Props = {
		value: string;
		onvalue: (v: string) => void;
		onsubmit: () => void;
		onkeydown?: (e: KeyboardEvent) => void;
		disabled?: boolean;
		placeholder?: string;
	};

	let {
		value,
		onvalue,
		onsubmit,
		onkeydown,
		disabled = false,
		placeholder = 'Message…'
	}: Props = $props();

	// Internal state — Carta owns this; we sync outward via $effect
	let internalValue = $state(value);

	// Sync inward when parent draft changes (e.g. after send clears it,
	// or when switching channels)
	$effect(() => {
		internalValue = value;
	});

	// Sync outward whenever internalValue changes
	$effect(() => {
		if (internalValue !== value) {
			onvalue(internalValue);
		}
	});

	const carta = new Carta({
		sanitizer: (html) => DOMPurify.sanitize(html)
	});

	function handleKeydown(e: KeyboardEvent) {
		// Enter (without Shift/Ctrl/Meta) = send
		if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
			e.preventDefault();
			onsubmit();
			return;
		}
		// Forward all other keys to parent (mention popup navigation)
		onkeydown?.(e);
	}
</script>

<!--
	MarkdownEditor in 'tabs' mode: a Write tab (plain textarea with
	syntax highlighting) and a Preview tab (rendered markdown).
	No split-pane — single tab at a time keeps the footer compact.
-->
<div class="carta-wrap" class:disabled>
	<div onkeydown={handleKeydown} role="presentation">
		<MarkdownEditor
			{carta}
			bind:value={internalValue}
			mode="tabs"
			placeholder={disabled ? '' : placeholder}
		/>
	</div>
</div>

<style>
	.carta-wrap {
		flex: 1;
		min-width: 0;
		position: relative;
		background: var(--finn-bg-input);
		border: 1px solid var(--finn-border);
		border-radius: var(--finn-radius-md);
		overflow: hidden;
		transition: border-color var(--finn-transition-fast);
	}
	.carta-wrap:focus-within {
		border-color: var(--finn-accent);
		box-shadow: 0 0 0 2px var(--finn-accent-glow);
	}
	.carta-wrap.disabled {
		opacity: 0.5;
		pointer-events: none;
	}

	/* Override Carta default.css for dark theme */
	.carta-wrap :global(.carta-wrapper) {
		background: transparent;
		border: none;
		border-radius: 0;
	}

	/* Tab bar (Write / Preview) */
	.carta-wrap :global(.carta-tabs) {
		background: var(--finn-bg-elevated);
		border-bottom: 1px solid var(--finn-border);
		display: flex;
		padding: 0 0.25rem;
		gap: 0.1rem;
	}
	.carta-wrap :global(.carta-tabs button) {
		background: transparent;
		border: none;
		border-bottom: 2px solid transparent;
		color: var(--finn-text-muted);
		padding: 0.25rem 0.65rem;
		font-size: var(--finn-text-xs);
		font-family: var(--finn-font-sans);
		cursor: pointer;
		transition: all var(--finn-transition-fast);
		margin-bottom: -1px;
	}
	.carta-wrap :global(.carta-tabs button:hover) {
		color: var(--finn-text-secondary);
	}
	.carta-wrap :global(.carta-tabs .active),
	.carta-wrap :global(.carta-tabs [aria-selected="true"]) {
		color: var(--finn-accent-hover);
		border-bottom-color: var(--finn-accent);
	}

	/* Toolbar */
	.carta-wrap :global(.carta-toolbar) {
		background: var(--finn-bg-elevated);
		border-bottom: 1px solid var(--finn-border);
		padding: 0.2rem 0.4rem;
		display: flex;
		gap: 0.15rem;
		flex-wrap: wrap;
	}
	.carta-wrap :global(.carta-toolbar button),
	.carta-wrap :global(.carta-toolbar-left button),
	.carta-wrap :global(.carta-toolbar-right button) {
		background: transparent;
		border: 1px solid transparent;
		color: var(--finn-text-muted);
		padding: 0.15rem 0.4rem;
		border-radius: var(--finn-radius-sm);
		cursor: pointer;
		font-size: var(--finn-text-xs);
		font-family: var(--finn-font-sans);
		line-height: 1.4;
		transition: all var(--finn-transition-fast);
	}
	.carta-wrap :global(.carta-toolbar button:hover) {
		background: var(--finn-bg-hover);
		color: var(--finn-text-primary);
		border-color: var(--finn-border);
	}

	/* Write area */
	.carta-wrap :global(.carta-input),
	.carta-wrap :global(textarea) {
		background: transparent;
		color: var(--finn-text-primary);
		border: none;
		font-family: var(--finn-font-sans);
		font-size: var(--finn-text-base);
		line-height: 1.5;
		padding: 0.5rem;
		min-height: 4rem;
		max-height: 12rem;
		overflow-y: auto;
		resize: none;
		width: 100%;
		caret-color: var(--finn-accent);
		outline: none;
	}

	/* Required by Carta for correct syntax overlay alignment */
	:global(.carta-font-code) {
		font-family: var(--finn-font-sans);
		font-size: var(--finn-text-base);
		line-height: 1.5;
		letter-spacing: normal;
	}

	/* Preview area */
	.carta-wrap :global(.carta-renderer) {
		background: transparent;
		color: var(--finn-text-primary);
		padding: 0.5rem;
		min-height: 4rem;
		font-size: var(--finn-text-base);
		line-height: 1.5;
	}
	.carta-wrap :global(.carta-renderer p) { margin: 0.25rem 0; }
	.carta-wrap :global(.carta-renderer code) {
		background: var(--finn-bg-elevated);
		color: var(--finn-accent-hover);
		padding: 0.1em 0.35em;
		border-radius: var(--finn-radius-sm);
		font-family: var(--finn-font-mono);
		font-size: 0.9em;
	}
	.carta-wrap :global(.carta-renderer pre) {
		background: var(--finn-bg-elevated);
		border: 1px solid var(--finn-border);
		border-radius: var(--finn-radius-md);
		padding: 0.5rem;
		overflow-x: auto;
	}
</style>
