<script lang="ts">
	import type { Snippet } from 'svelte';

	type Props = {
		open: boolean;
		title: string;
		onClose: () => void;
		children: Snippet;
	};

	let { open, title, onClose, children }: Props = $props();

	function onBackdropClick(e: MouseEvent) {
		// Click outside the modal panel = close.
		if (e.target === e.currentTarget) onClose();
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') onClose();
	}
</script>

<svelte:window onkeydown={onKey} />

{#if open}
	<div class="backdrop" role="presentation" onclick={onBackdropClick}>
		<div class="panel" role="dialog" aria-modal="true" aria-label={title}>
			<header>
				<h2>{title}</h2>
				<button class="close" onclick={onClose} aria-label="close">×</button>
			</header>
			<div class="body">
				{@render children()}
			</div>
		</div>
	</div>
{/if}

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.55);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 100;
	}
	.panel {
		background: #16161a;
		border: 1px solid #2a2a30;
		border-radius: 8px;
		min-width: 480px;
		max-width: 90vw;
		max-height: 90vh;
		display: flex;
		flex-direction: column;
		box-shadow: 0 20px 50px rgba(0, 0, 0, 0.6);
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.6rem 0.75rem 0.6rem 1rem;
		border-bottom: 1px solid #2a2a30;
	}
	header h2 {
		margin: 0;
		font-size: 0.95rem;
		font-weight: 600;
	}
	.close {
		background: transparent;
		border: 0;
		color: #888;
		font-size: 1.4rem;
		line-height: 1;
		cursor: pointer;
		padding: 0 0.25rem;
	}
	.close:hover {
		color: #e8e8ea;
	}
	.body {
		padding: 1rem;
		overflow-y: auto;
	}
</style>
