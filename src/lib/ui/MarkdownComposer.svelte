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

	function handlePaste(e: ClipboardEvent) {
		const items = e.clipboardData?.items;
		if (!items) return;
		for (const item of items) {
			if (item.type.startsWith('image/')) {
				e.preventDefault();
				const file = item.getAsFile();
				if (!file) return;
				const reader = new FileReader();
				reader.onload = () => {
					const dataUrl = reader.result as string;
					const md = `![image](${dataUrl})`;
					if (!ta) return;
					const start = ta.selectionStart;
					const before = value.slice(0, start);
					const after = value.slice(ta.selectionEnd);
					const sep = before.length > 0 && !before.endsWith('\n') ? '\n' : '';
					onvalue(before + sep + md + '\n' + after);
					autosize();
				};
				reader.readAsDataURL(file);
				return;
			}
		}
		// Not an image — let the browser handle normal text paste
	}
</script>

<div class="composer-wrap" class:disabled>
	<!-- Toolbar floats ABOVE the box border: position:absolute bottom:100% -->
	<div class="toolbar" aria-label="Formatting">
		<button type="button" onclick={() => wrap('**', '**', 'bold')}  title="Bold (Ctrl+B)"><b>B</b></button>
		<button type="button" onclick={() => wrap('_', '_', 'italic')}  title="Italic (Ctrl+I)"><i>I</i></button>
		<button type="button" onclick={() => wrap('`', '`', 'code')}    title="Code (Ctrl+E)"><code>`</code></button>
		<button type="button" onclick={insertLink}                       title="Link">🔗</button>
	</div>

	<textarea
		bind:this={ta}
		{value}
		oninput={(e) => {
			onvalue((e.currentTarget as HTMLTextAreaElement).value);
			autosize();
		}}
		onkeydown={handleKeydown}
		onpaste={handlePaste}
		{placeholder}
		{disabled}
		rows="2"
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
		overflow: visible; /* allow toolbar to float above the border */
	}
	.composer-wrap:focus-within {
		border-color: var(--finn-accent);
		box-shadow: 0 0 0 2px var(--finn-accent-glow);
	}
	.composer-wrap.disabled {
		opacity: 0.45;
		pointer-events: none;
	}

	/* Toolbar floats ABOVE the textarea border */
	.toolbar {
		position: absolute;
		bottom: 100%;
		right: 0;
		margin-bottom: 0.2rem;
		display: flex;
		gap: 0.2rem;
		z-index: 1;
	}
	.toolbar button {
		background: var(--finn-accent);
		border: none;
		color: #fff;
		padding: 0.15rem 0.5rem;
		border-radius: var(--finn-radius-sm);
		cursor: pointer;
		font-size: 0.72rem;
		font-weight: 600;
		line-height: 1.5;
		font-family: var(--finn-font-sans);
		transition: background var(--finn-transition-fast), box-shadow var(--finn-transition-fast);
	}
	.toolbar button:hover {
		background: var(--finn-accent-hover);
		box-shadow: var(--finn-shadow-glow);
	}
	.toolbar button b    { font-weight: 800; }
	.toolbar button i    { font-style: italic; font-weight: 600; }
	.toolbar button code { font-family: var(--finn-font-mono); font-size: 0.78rem; font-weight: 600; }

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
		resize: none;
		min-height: 0;
		max-height: 10rem;
		overflow-y: auto;
		outline: none;
		caret-color: var(--finn-accent);
	}
	textarea::placeholder { color: var(--finn-text-disabled); }
</style>
