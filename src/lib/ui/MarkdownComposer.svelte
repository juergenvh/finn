<script lang="ts">
	/**
	 * MarkdownComposer — a plain textarea with a minimal markdown toolbar.
	 *
	 * Four buttons (Bold, Italic, Code, Link) wrap the selection or insert
	 * markdown syntax at the cursor. Everything else stays a textarea so
	 * there is exactly ONE visual box with no library fighting the styling.
	 */

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

	let ta: HTMLTextAreaElement | undefined = $state();

	function handleKeydown(e: KeyboardEvent) {
		// Keyboard shortcuts
		if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
			if (e.key === 'b') { e.preventDefault(); wrap('**', '**', 'bold text'); return; }
			if (e.key === 'i') { e.preventDefault(); wrap('_', '_', 'italic text'); return; }
			if (e.key === 'e') { e.preventDefault(); wrap('`', '`', 'code'); return; }
		}
		if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
			e.preventDefault();
			onsubmit();
			return;
		}
		onkeydown?.(e);
	}

	/** Wrap selection with prefix/suffix, or insert placeholder if nothing selected. */
	function wrap(prefix: string, suffix: string, placeholder: string) {
		if (!ta) return;
		const start = ta.selectionStart;
		const end = ta.selectionEnd;
		const selected = value.slice(start, end) || placeholder;
		const before = value.slice(0, start);
		const after = value.slice(end);
		const inserted = `${prefix}${selected}${suffix}`;
		const newValue = `${before}${inserted}${after}`;
		onvalue(newValue);
		// Restore cursor after Svelte updates the textarea
		requestAnimationFrame(() => {
			if (!ta) return;
			const newStart = start + prefix.length;
			const newEnd = newStart + selected.length;
			ta.setSelectionRange(newStart, newEnd);
			ta.focus();
		});
	}

	function insertLink() {
		if (!ta) return;
		const start = ta.selectionStart;
		const end = ta.selectionEnd;
		const selected = value.slice(start, end) || 'link text';
		const before = value.slice(0, start);
		const after = value.slice(end);
		const inserted = `[${selected}](url)`;
		onvalue(`${before}${inserted}${after}`);
		requestAnimationFrame(() => {
			if (!ta) return;
			// Select "url" part so user can type it immediately
			const urlStart = before.length + selected.length + 3;
			ta.setSelectionRange(urlStart, urlStart + 3);
			ta.focus();
		});
	}

	function autosize() {
		if (!ta) return;
		ta.style.height = 'auto';
		ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
	}
</script>

<div class="composer-wrap" class:disabled>
	<!-- Floating toolbar badges -->
	<div class="toolbar" aria-label="Formatting">
		<button type="button" onclick={() => wrap('**', '**', 'bold')}      title="Bold (Ctrl+B)"><b>B</b></button>
		<button type="button" onclick={() => wrap('_', '_', 'italic')}      title="Italic (Ctrl+I)"><i>I</i></button>
		<button type="button" onclick={() => wrap('`', '`', 'code')}        title="Code (Ctrl+E)"><code>`</code></button>
		<button type="button" onclick={insertLink}                           title="Link">🔗</button>
	</div>

	<textarea
		bind:this={ta}
		{value}
		oninput={(e) => {
			onvalue((e.currentTarget as HTMLTextAreaElement).value);
			autosize();
		}}
		onkeydown={handleKeydown}
		{placeholder}
		{disabled}
		rows="1"
	></textarea>
</div>

<style>
	.composer-wrap {
		flex: 1;
		min-width: 0;
		position: relative;
		background: var(--finn-bg-input);
		border: 1px solid var(--finn-border);
		border-radius: var(--finn-radius-md);
		transition: border-color var(--finn-transition-fast);
	}
	.composer-wrap:focus-within {
		border-color: var(--finn-accent);
		box-shadow: 0 0 0 2px var(--finn-accent-glow);
	}
	.composer-wrap.disabled {
		opacity: 0.45;
		pointer-events: none;
	}

	/* Floating badges — top-right corner */
	.toolbar {
		position: absolute;
		top: 0.25rem;
		right: 0.35rem;
		display: flex;
		gap: 0.15rem;
		z-index: 1;
	}
	.toolbar button {
		background: var(--finn-bg-elevated);
		border: 1px solid var(--finn-border);
		color: var(--finn-text-muted);
		padding: 0.1rem 0.35rem;
		border-radius: var(--finn-radius-sm);
		cursor: pointer;
		font-size: 0.72rem;
		line-height: 1.4;
		font-family: var(--finn-font-sans);
		transition: all var(--finn-transition-fast);
		opacity: 0.75;
	}
	.toolbar button:hover {
		background: var(--finn-bg-hover);
		color: var(--finn-text-primary);
		border-color: var(--finn-border-hover);
		opacity: 1;
	}
	.toolbar button b  { font-weight: 700; }
	.toolbar button i  { font-style: italic; }
	.toolbar button code { font-family: var(--finn-font-mono); font-size: 0.75rem; }

	textarea {
		width: 100%;
		box-sizing: border-box;
		background: transparent;
		border: none;
		color: var(--finn-text-primary);
		font-family: var(--finn-font-sans);
		font-size: var(--finn-text-base);
		line-height: 1.5;
		padding: 0.4rem 0.5rem;
		padding-right: 6.5rem; /* space for toolbar badges */
		resize: none;
		min-height: 0;
		max-height: 10rem;
		overflow-y: auto;
		outline: none;
		caret-color: var(--finn-accent);
	}
	textarea::placeholder { color: var(--finn-text-disabled); }
</style>
