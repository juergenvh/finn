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
		/**
		 * Bindable reference to the underlying textarea. The parent needs it
		 * to drive @mention autocomplete (caret position + setSelectionRange).
		 */
		element?: HTMLTextAreaElement;
	};

	let {
		value,
		onvalue,
		onsubmit,
		onkeydown,
		disabled = false,
		placeholder = 'Message…',
		element = $bindable()
	}: Props = $props();

	// Internal alias kept so the rest of the component reads naturally.
	let ta = $derived(element);

	function handleKeydown(e: KeyboardEvent) {
		// Keyboard shortcuts
		if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
			if (e.key === 'b') { e.preventDefault(); wrap('**', '**', 'bold text'); return; }
			if (e.key === 'i') { e.preventDefault(); wrap('_', '_', 'italic text'); return; }
			if (e.key === 'e') { e.preventDefault(); wrap('`', '`', 'code'); return; }
		}
		// Give the parent first look at the keystroke — e.g. to accept a
		// highlighted @mention candidate on Enter/Tab — before treating a
		// bare Enter as "submit the message". Previously this ran the
		// other way round, so Enter always submitted and the parent's
		// mention-accept handler never saw it. See issue #215 / U2.
		onkeydown?.(e);
		if (e.defaultPrevented) return;
		if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
			e.preventDefault();
			onsubmit();
		}
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

	/**
	 * Pasted images are inlined as base64 `data:` URIs (the renderer
	 * allows `data:image/*` alongside `https://`, see markdown.ts and
	 * ADR-0023 §2). Unlike an `https://` image reference, the bytes
	 * live directly in the message body — DB row, WS frame, and every
	 * viewer's memory — so unlike ADR-0023 §3's "no byte-size limit"
	 * stance for linked images, a cap here is load-bearing, not
	 * optional. See issue #216 / U3 / S5.
	 */
	const MAX_PASTE_IMAGE_BYTES = 1_000_000;

	let pasteError = $state<string | null>(null);

	function insertImageMarkdown(dataUrl: string) {
		if (!ta) return;
		const start = ta.selectionStart;
		const before = value.slice(0, start);
		const after = value.slice(ta.selectionEnd);
		const sep = before.length > 0 && !before.endsWith('\n') ? '\n' : '';
		onvalue(before + sep + `![image](${dataUrl})` + '\n' + after);
		autosize();
	}

	function readAndInsertImage(file: File) {
		const reader = new FileReader();
		reader.onload = () => insertImageMarkdown(reader.result as string);
		reader.onerror = () => {
			// Previously silent — a failed read (corrupt clipboard data,
			// browser quirk) just did nothing, with no sign anything was
			// even attempted. See issue #216 / U3 / U17.
			pasteError = 'Could not read pasted image.';
		};
		reader.readAsDataURL(file);
	}

	function handlePaste(e: ClipboardEvent) {
		const items = e.clipboardData?.items;
		if (!items) return;
		let sawImage = false;
		for (const item of items) {
			if (!item.type.startsWith('image/')) continue;
			sawImage = true;
			const file = item.getAsFile();
			if (!file) continue;
			if (file.size > MAX_PASTE_IMAGE_BYTES) {
				pasteError = `Image too large to paste (${Math.round(file.size / 1024)} KB, max ${Math.round(MAX_PASTE_IMAGE_BYTES / 1024)} KB).`;
				continue;
			}
			pasteError = null;
			readAndInsertImage(file);
		}
		// Previously only the first clipboard item was ever considered
		// (an early `return` inside the loop); a multi-image paste
		// silently dropped everything after the first. See issue #216 /
		// U3 / U17.
		if (sawImage) e.preventDefault();
		// No image items — let the browser handle normal text paste.
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
		bind:this={element}
		{value}
		oninput={(e) => {
			pasteError = null;
			onvalue((e.currentTarget as HTMLTextAreaElement).value);
			autosize();
		}}
		onkeydown={handleKeydown}
		onpaste={handlePaste}
		{placeholder}
		{disabled}
		rows="2"
	></textarea>
	{#if pasteError}
		<p class="paste-error" role="alert">{pasteError}</p>
	{/if}
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

	.paste-error {
		margin: 0;
		padding: 0.2rem 0.5rem 0.4rem;
		font-size: var(--finn-text-xs);
		color: var(--finn-error);
	}
</style>
