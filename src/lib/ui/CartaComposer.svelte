<script lang="ts">
	import { Carta, MarkdownEditor } from 'carta-md';
	import 'carta-md/default.css';
	import DOMPurify from 'dompurify';
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';

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

	// Carta's JS sets inline min-height on the textarea — reset it so our CSS controls sizing
	onMount(() => {
		const reset = () => {
			const ta = wrapEl?.querySelector<HTMLTextAreaElement>('textarea');
			if (ta) {
				ta.rows = 1;
				ta.style.minHeight = '0';
				ta.style.height = 'auto';
			}
		};
		// Small delay for Carta's own init to finish
		setTimeout(reset, 100);
	});

	let wrapEl: HTMLDivElement | undefined = $state();

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
			e.preventDefault();
			onsubmit();
			return;
		}
		onkeydown?.(e);
	}
</script>

<div class="carta-wrap" class:disabled onkeydown={handleKeydown} role="presentation" bind:this={wrapEl}>
	<MarkdownEditor
		{carta}
		bind:value={internalValue}
		mode="tabs"
		placeholder={disabled ? '' : placeholder}
	/>
</div>

<style>
	/*
	 * ONE visual box: .carta-wrapper is the border/bg.
	 * Toolbar floats as badges in the top-right corner — no separate strip.
	 * Write/Preview toggle and renderer are permanently hidden.
	 */
	.carta-wrap {
		flex: 1;
		min-width: 0;
		position: relative;
	}
	.carta-wrap.disabled { opacity: 0.5; pointer-events: none; }

	/* THE single visual box */
	.carta-wrap :global(.carta-wrapper) {
		background: var(--finn-bg-input);
		border: 1px solid var(--finn-border);
		border-radius: var(--finn-radius-md);
		overflow: visible;
		position: relative;
		transition: border-color var(--finn-transition-fast);
	}
	.carta-wrap:focus-within :global(.carta-wrapper) {
		border-color: var(--finn-accent);
		box-shadow: 0 0 0 2px var(--finn-accent-glow);
	}

	/* Hide Write/Preview toggle + renderer */
	.carta-wrap :global(.carta-toolbar-left) { display: none !important; }
	.carta-wrap :global(.carta-renderer) { display: none !important; }

	/* Floating badge toolbar — top-right corner of the box */
	.carta-wrap :global(.carta-toolbar) {
		position: absolute;
		top: 0.2rem;
		right: 0.3rem;
		z-index: 2;
		background: transparent;
		border: none;
		padding: 0;
		display: flex;
		gap: 0.15rem;
		align-items: center;
	}
	.carta-wrap :global(.carta-toolbar-right) {
		display: flex;
		gap: 0.15rem;
		align-items: center;
	}
	/* Badge-style buttons */
	.carta-wrap :global(.carta-toolbar button),
	.carta-wrap :global(.carta-toolbar-right button),
	.carta-wrap :global(.carta-icon) {
		background: var(--finn-bg-elevated);
		border: 1px solid var(--finn-border);
		color: var(--finn-text-muted);
		padding: 0.1rem 0.35rem;
		border-radius: var(--finn-radius-sm);
		cursor: pointer;
		font-size: 0.72rem;
		font-family: var(--finn-font-sans);
		line-height: 1.3;
		transition: all var(--finn-transition-fast);
		opacity: 0.7;
	}
	.carta-wrap :global(.carta-toolbar button:hover),
	.carta-wrap :global(.carta-icon:hover) {
		background: var(--finn-bg-hover);
		color: var(--finn-text-primary);
		border-color: var(--finn-border-hover);
		opacity: 1;
	}
	/* SVG icons inside buttons — compact */
	.carta-wrap :global(.carta-toolbar svg) {
		width: 0.85rem;
		height: 0.85rem;
		display: block;
	}

	/* Compact height — override Carta's default.css which sets height:600px on theme */
	.carta-wrap :global(.carta-theme__default .carta-input),
	.carta-wrap :global(.carta-theme__default .carta-renderer),
	.carta-wrap :global(.carta-container),
	.carta-wrap :global(.carta-input-wrapper),
	.carta-wrap :global(.carta-input) {
		min-height: 0 !important;
		height: auto !important;
	}

	/* Textarea — single line by default, grows to max-height */
	.carta-wrap :global(textarea) {
		background: transparent;
		color: var(--finn-text-primary);
		border: none;
		font-family: var(--finn-font-sans);
		font-size: var(--finn-text-base);
		line-height: 1.5;
		padding: 0.45rem 0.5rem;
		padding-right: 7rem; /* room for floating badge row */
		min-height: 0 !important;
		height: auto !important;
		max-height: 8rem;
		overflow-y: auto;
		resize: none;
		width: 100%;
		box-sizing: border-box;
		caret-color: var(--finn-accent);
		outline: none;
		rows: 1;
	}
	/* Syntax-highlight overlay — must match textarea size */
	.carta-wrap :global(.carta-highlight) {
		min-height: 0 !important;
		height: auto !important;
	}

	:global(.carta-font-code) {
		font-family: var(--finn-font-sans);
		font-size: var(--finn-text-base);
		line-height: 1.5;
		letter-spacing: normal;
	}
</style>
