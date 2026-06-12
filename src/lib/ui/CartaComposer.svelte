<script lang="ts">
	import { Carta, MarkdownEditor } from 'carta-md';
	import 'carta-md/default.css';
	import DOMPurify from 'dompurify';
	import { browser } from '$app/environment';

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

	// svelte-ignore state_referenced_locally -- intentional: initial value only, $effect syncs inward
	let internalValue = $state(value);

	// Sync inward when parent draft changes (channel switch, send clear)
	$effect(() => { internalValue = value; });
	// Sync outward on every edit
	$effect(() => { if (internalValue !== value) onvalue(internalValue); });

	// DOMPurify requires a DOM — skip on SSR (no user HTML rendered server-side anyway)
	const sanitize =
		browser && typeof DOMPurify.sanitize === 'function'
			? (html: string) => DOMPurify.sanitize(html) as string
			: (html: string) => html;

	const carta = new Carta({ sanitizer: sanitize });

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
			e.preventDefault();
			onsubmit();
			return;
		}
		onkeydown?.(e);
	}
</script>

<div class="carta-wrap" class:disabled onkeydown={handleKeydown} role="presentation">
	<MarkdownEditor
		{carta}
		bind:value={internalValue}
		mode="tabs"
		placeholder={disabled ? '' : placeholder}
	/>
</div>

<style>
	/* No outer border — the footer already provides the visual container */
	.carta-wrap {
		flex: 1;
		min-width: 0;
		position: relative;
	}
	.carta-wrap.disabled { opacity: 0.5; pointer-events: none; }

	/* Hide the Write/Preview tab bar — editor only */
	.carta-wrap :global(.carta-tabs) { display: none; }

	/* Carta wrapper: transparent, no border */
	.carta-wrap :global(.carta-wrapper) {
		background: transparent;
		border: none;
		border-radius: 0;
	}

	/* Toolbar */
	.carta-wrap :global(.carta-toolbar),
	.carta-wrap :global(.carta-toolbar-left),
	.carta-wrap :global(.carta-toolbar-right) {
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
		padding: 0.15rem 0.5rem;
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
		min-height: 3.5rem;
		max-height: 12rem;
		overflow-y: auto;
		resize: none;
		width: 100%;
		caret-color: var(--finn-accent);
		outline: none;
	}

	/* Required by Carta for correct syntax-highlight overlay alignment */
	:global(.carta-font-code) {
		font-family: var(--finn-font-sans);
		font-size: var(--finn-text-base);
		line-height: 1.5;
		letter-spacing: normal;
	}
</style>
