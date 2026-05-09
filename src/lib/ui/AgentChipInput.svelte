<script lang="ts">
	/**
	 * Email-client-style chip input for selecting channel-member
	 * agents (issue #26).
	 *
	 * Owns:
	 * - The visible chip rail + an inline `<input>` for typing.
	 * - The autocomplete dropdown (mounted via `MentionPopup`).
	 * - Keyboard handling: Arrow / Enter / Tab / Backspace /
	 *   Escape per the contract in #26's discovery comment.
	 *
	 * The selected-agent set is owned by the parent and passed in
	 * controlled-component-style via `value` + `onChange`. The
	 * parent's existing data shape (`Set<string>` of agent ids)
	 * carries through unchanged so `ChannelForm`'s submit logic
	 * doesn't move.
	 *
	 * Trigger char: **none** — typing in this context already
	 * means "pick an agent". The composer's `@`-prefix is its own
	 * thing; they share `MentionPopup` but not the trigger logic.
	 */
	import type { AgentInfo } from './types';
	import MentionPopup from './MentionPopup.svelte';

	type Props = {
		/** Full agent list to filter against. Disabled and deleted
		 * agents are excluded from the candidate pool by the parent
		 * (or here, defensively). */
		allAgents: AgentInfo[];
		/** Controlled set of selected agent ids. Parent owns the
		 * source of truth; this component calls `onChange` whenever
		 * the set is mutated and never mutates `value` directly. */
		value: Set<string>;
		onChange: (next: Set<string>) => void;
		/** Placeholder for the inline input when the chip set is
		 * empty. Defaults to a sensible English string; pass in to
		 * customise. */
		placeholder?: string;
	};

	let {
		allAgents,
		value,
		onChange,
		placeholder = 'Add agents...'
	}: Props = $props();

	const POPUP_ID = 'agent-chip-input-popup';

	let inputEl: HTMLInputElement | null = $state(null);
	let query = $state('');
	let highlightedIndex = $state(0);

	/* The candidate list: enabled agents, prefix-matching the
	 * current query, excluding any already in `value`. Empty
	 * query → no candidates (don't dump the full list on focus,
	 * per #26 discovery §2). Mirrors the predicate the composer's
	 * mention autocomplete uses. */
	const candidates = $derived.by<AgentInfo[]>(() => {
		const q = query.trim().toLowerCase();
		if (q.length === 0) return [];
		return allAgents
			.filter((a) => a.enabled)
			.filter((a) => !value.has(a.id))
			.filter((a) => a.name.toLowerCase().startsWith(q))
			.slice(0, 8);
	});

	const popupOpen = $derived(candidates.length > 0);

	/* Reset highlight to top whenever the candidate set changes
	 * shape — keeps the user's expectation that "the first match
	 * is selected by default" stable across keystrokes. */
	$effect(() => {
		void candidates.length;
		highlightedIndex = 0;
	});

	function selectAgent(agent: AgentInfo): void {
		if (value.has(agent.id)) return;
		const next = new Set(value);
		next.add(agent.id);
		onChange(next);
		query = '';
		// Keep focus in the input so the user can chain selections.
		queueMicrotask(() => inputEl?.focus());
	}

	function removeChip(agentId: string): void {
		if (!value.has(agentId)) return;
		const next = new Set(value);
		next.delete(agentId);
		onChange(next);
	}

	function nameOf(agentId: string): string {
		return allAgents.find((a) => a.id === agentId)?.name ?? agentId;
	}

	function onInputKey(e: KeyboardEvent): void {
		if (popupOpen) {
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				highlightedIndex = (highlightedIndex + 1) % candidates.length;
				return;
			}
			if (e.key === 'ArrowUp') {
				e.preventDefault();
				highlightedIndex =
					(highlightedIndex - 1 + candidates.length) % candidates.length;
				return;
			}
			if (e.key === 'Enter' || e.key === 'Tab') {
				const choice = candidates[highlightedIndex];
				if (choice) {
					e.preventDefault();
					selectAgent(choice);
				}
				return;
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				query = '';
				return;
			}
		} else if (e.key === 'Enter') {
			// Popup is closed (query empty or no match). Swallow
			// Enter so the surrounding form doesn't submit just
			// because the user pressed Enter while the chip input
			// happened to have focus. The user submits via the
			// form's primary button, deliberately.
			e.preventDefault();
			return;
		}
		if (e.key === 'Backspace' && query.length === 0) {
			// Empty input + backspace removes the rightmost chip.
			// (Preserved across renders; chips are ordered by
			// insertion via Set iteration order.)
			const ids = [...value];
			const last = ids[ids.length - 1];
			if (last) {
				e.preventDefault();
				removeChip(last);
			}
		}
	}
</script>

<div class="chip-field">
	<div
		class="chip-input"
		role="combobox"
		aria-expanded={popupOpen}
		aria-controls={POPUP_ID}
		aria-haspopup="listbox"
	>
		{#each [...value] as agentId (agentId)}
			<span class="chip">
				<span class="chip-name">{nameOf(agentId)}</span>
				<button
					type="button"
					class="chip-remove"
					title="remove {nameOf(agentId)}"
					aria-label="remove {nameOf(agentId)}"
					onclick={() => removeChip(agentId)}
				>×</button>
			</span>
		{/each}

		<input
			bind:this={inputEl}
			bind:value={query}
			class="chip-input-field"
			type="text"
			placeholder={value.size === 0 ? placeholder : ''}
			autocomplete="off"
			onkeydown={onInputKey}
			aria-autocomplete="list"
			aria-activedescendant={popupOpen ? `${POPUP_ID}-${highlightedIndex}` : undefined}
		/>

		<MentionPopup
			open={popupOpen}
			candidates={candidates}
			highlightedIndex={highlightedIndex}
			onSelect={selectAgent}
			id={POPUP_ID}
			placement="below"
		/>
	</div>
</div>

<style>
	.chip-field {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}

	.chip-input {
		position: relative;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.3rem;
		min-height: 2.4rem;
		padding: 0.3rem 0.4rem;
		background: #0e0e10;
		border: 1px solid #2a2a30;
		border-radius: 4px;
	}
	.chip-input:focus-within {
		border-color: #38bdf8;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		background: rgba(56, 189, 248, 0.12);
		color: #38bdf8;
		padding: 0.15rem 0.45rem 0.15rem 0.55rem;
		border-radius: 9999px;
		font-size: 0.85rem;
		line-height: 1.2;
	}
	.chip-name {
		font-weight: 500;
	}
	.chip-remove {
		background: transparent;
		border: 0;
		color: inherit;
		padding: 0 0.1rem;
		font-size: 0.95rem;
		line-height: 1;
		cursor: pointer;
		opacity: 0.7;
	}
	.chip-remove:hover {
		opacity: 1;
	}

	.chip-input-field {
		flex: 1;
		min-width: 8rem;
		background: transparent;
		border: 0;
		color: #e8e8ea;
		font-family: inherit;
		font-size: 0.95rem;
		padding: 0.15rem 0.25rem;
		outline: none;
	}
</style>
