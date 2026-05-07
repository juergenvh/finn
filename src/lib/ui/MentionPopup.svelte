<script lang="ts">
	/**
	 * Mention autocomplete popup.
	 *
	 * Owned by the parent (the message composer); the parent decides
	 * when to show it and which candidates to display.
	 *
	 * Keyboard navigation lives here; the parent forwards down/up/
	 * enter/tab/escape via key events. (We can't bind the keyboard
	 * inside this component because the actual focus belongs to the
	 * textarea, not the popup.)
	 */
	import type { AgentInfo } from './types';

	type Props = {
		open: boolean;
		candidates: AgentInfo[];
		highlightedIndex: number;
		onSelect: (agent: AgentInfo) => void;
	};

	let { open, candidates, highlightedIndex, onSelect }: Props = $props();
</script>

{#if open && candidates.length > 0}
	<div class="popup" role="listbox" aria-label="mention candidates">
		{#each candidates as a, i (a.id)}
			<button
				type="button"
				class="row"
				class:highlighted={i === highlightedIndex}
				onmousedown={(e) => {
					e.preventDefault();
					onSelect(a);
				}}
			>
				<span class="dot" class:disabled={!a.enabled}></span>
				<span class="name">{a.name}</span>
				<span class="connector">{a.connectorType}</span>
			</button>
		{/each}
	</div>
{/if}

<style>
	.popup {
		position: absolute;
		bottom: calc(100% + 0.25rem);
		left: 0.75rem;
		background: #1f1f24;
		border: 1px solid #2a2a30;
		border-radius: 6px;
		box-shadow: 0 8px 28px rgba(0, 0, 0, 0.55);
		max-height: 14rem;
		min-width: 220px;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		z-index: 50;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		text-align: left;
		background: transparent;
		border: 0;
		color: #cbd5e1;
		padding: 0.4rem 0.6rem;
		font-family: inherit;
		font-size: 0.9rem;
		cursor: pointer;
	}
	.row:hover,
	.row.highlighted {
		background: #2a2a30;
		color: #f1f5f9;
	}
	.dot {
		width: 0.45rem;
		height: 0.45rem;
		border-radius: 50%;
		background: #6ee7b7;
		display: inline-block;
		flex-shrink: 0;
	}
	.dot.disabled {
		background: #555;
	}
	.name {
		font-weight: 500;
	}
	.connector {
		color: #64748b;
		font-size: 0.75rem;
		margin-left: auto;
	}
</style>
