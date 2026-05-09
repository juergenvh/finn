/**
 * Markdown rendering pipeline for message bodies (ADR-0016).
 *
 * Same code path for user and agent bubbles (per ADR §2):
 *
 *   markdown source
 *     → marked.parse(markdown, { breaks: true, gfm: true })
 *     → DOMPurify.sanitize(html, ALLOWLIST)
 *     → mention post-process (DOM walk; styled span when token
 *                              resolves against the channel members)
 *     → returned HTML string
 *
 * Caller does `{@html result}`. The sanitizer is the safety
 * control; the source (user vs agent) is **not** what makes a
 * body safe — same allowlist applies regardless. See ADR-0001
 * for the connector trust posture and ADR-0016 §3 for the
 * sanitizer policy.
 */

import { marked } from 'marked';
import DOMPurify, { type Config as DOMPurifyConfig } from 'dompurify';
import type { AgentInfo } from './types';

/* ---------- marked configuration --------------------------- */

/**
 * `breaks: true` turns single newlines into `<br>` (chat-shaped
 * line semantics) instead of collapsing them (HTML-shaped). Double
 * newlines still produce paragraph breaks, so verbatim multi-line
 * content keeps its shape. GFM gives us tables, strikethrough, and
 * autolinks — all useful, all zero-cost.
 *
 * marked is sync and idempotent; configuring once at module load
 * is fine, no per-call setOptions.
 */
marked.use({
	gfm: true,
	breaks: true
});

/* ---------- DOMPurify allowlist ---------------------------- */

/**
 * Sanitizer policy. Tighter than DOMPurify defaults in places
 * where we want the contract auditable (per ADR-0016 §3).
 *
 * `FORBID_*` lists are explicit even where DOMPurify already
 * blocks the tag/attr by default — pinning makes the policy
 * readable in one place rather than scattering it across the
 * library version we happen to be on today.
 */
const SANITIZE_CONFIG: DOMPurifyConfig = {
	// Forbid these even though most are off by default — pin the
	// contract for clarity and survival across DOMPurify upgrades.
	FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'style', 'link'],
	// Strip target attribute on links (open-in-place; revisit on
	// real user feedback). Inline event handlers and dangerous URL
	// schemes are handled by DOMPurify's defaults plus our hook
	// below.
	FORBID_ATTR: ['target'],
	// We never need raw <html>/<body> wrappers; DOMPurify will
	// honour this. Adds a strict mode for the output.
	WHOLE_DOCUMENT: false,
	RETURN_DOM_FRAGMENT: false,
	RETURN_TRUSTED_TYPE: false
};

/**
 * Belt-and-suspenders: DOMPurify already blocks `javascript:`
 * URLs and most exotic schemes. We additionally drop `data:` URLs
 * in `href` because we don't render images today (revisit when
 * image embedding becomes a feature). Hook installs once.
 */
let hooksInstalled = false;
function installHooksOnce(): void {
	if (hooksInstalled) return;
	hooksInstalled = true;
	DOMPurify.addHook('afterSanitizeAttributes', (node) => {
		if (!(node instanceof Element)) return;
		const href = node.getAttribute('href');
		if (href && /^data:/i.test(href.trim())) {
			node.removeAttribute('href');
		}
	});
}

/* ---------- mention post-processor ------------------------- */

/**
 * Walk a freshly-sanitized HTML fragment and replace `@<token>`
 * mentions with styled spans, but only when:
 *
 * - the token resolves against the supplied member list (by lower-
 *   cased name match — same predicate the server uses; keeps the
 *   diagnostics aligned with `mentions.ts`),
 * - the text node is NOT inside `<code>`, `<pre>`, or an existing
 *   `<a>` (mentions in code blocks are literals; mentions inside
 *   markdown links retain the link as-authored).
 *
 * Tokens that don't resolve are left alone — same posture as the
 * dispatcher's `unresolvedMentionTokens` diagnostic, no surprise
 * styling.
 */
const MENTION_RE = /(^|[^\w@])@([\p{L}\p{N}_.\-]+)/gu;
const SKIP_TAGS = new Set(['CODE', 'PRE', 'A']);

function isInsideSkippedAncestor(el: Element | null): boolean {
	let cur: Element | null = el;
	while (cur) {
		if (SKIP_TAGS.has(cur.tagName)) return true;
		cur = cur.parentElement;
	}
	return false;
}

function postProcessMentions(root: HTMLElement, members: AgentInfo[]): void {
	if (members.length === 0) return;

	// Build the lookup once per call. Lower-cased name → display
	// name. Resolution by name is what the user types in chat;
	// id-mentions are technically also valid (server accepts both)
	// but the bubble shows names, and mention-styling is a UI
	// affordance, not a routing decision — name-only here is fine.
	const byName = new Map<string, AgentInfo>();
	for (const m of members) {
		byName.set(m.name.toLowerCase(), m);
	}

	// Snapshot text nodes first; mutating during traversal would
	// confuse the walker.
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const textNodes: Text[] = [];
	let n = walker.nextNode();
	while (n) {
		textNodes.push(n as Text);
		n = walker.nextNode();
	}

	for (const node of textNodes) {
		if (isInsideSkippedAncestor(node.parentElement)) continue;
		const text = node.nodeValue ?? '';
		if (!text.includes('@')) continue;

		MENTION_RE.lastIndex = 0;
		let lastIdx = 0;
		let match: RegExpExecArray | null;
		const fragments: Array<Node> = [];
		let mutated = false;

		while ((match = MENTION_RE.exec(text)) !== null) {
			const [whole, leading, token] = match;
			const member = byName.get(token!.toLowerCase());
			if (!member) continue;

			mutated = true;
			const start = match.index + leading!.length; // index of '@'
			const end = match.index + whole!.length;

			if (start > lastIdx) {
				fragments.push(document.createTextNode(text.slice(lastIdx, start)));
			}

			const span = document.createElement('span');
			span.className = 'mention';
			span.textContent = `@${member.name}`;
			// Carry the resolved id for any future click-handlers
			// (member detail panel, etc.) without binding behaviour
			// today.
			span.dataset.agentId = member.id;
			fragments.push(span);

			lastIdx = end;
		}

		if (!mutated) continue;
		if (lastIdx < text.length) {
			fragments.push(document.createTextNode(text.slice(lastIdx)));
		}
		const parent = node.parentNode;
		if (!parent) continue;
		for (const frag of fragments) parent.insertBefore(frag, node);
		parent.removeChild(node);
	}
}

/* ---------- public API ------------------------------------- */

/**
 * Render a message body to sanitized HTML with mention-spans.
 *
 * Server-side rendering: `document` is undefined; we return the
 * sanitized HTML without mention-post-processing. The client
 * hydrates and the component re-runs render after mount when
 * `document` is available, so SSR mention output isn't visible
 * to anyone in practice.
 */
export function renderMarkdown(body: string, members: AgentInfo[]): string {
	if (typeof document === 'undefined') {
		// SSR path: parse + sanitize without DOM mention-walk.
		const html = marked.parse(body, { async: false }) as string;
		return DOMPurify.sanitize(html, SANITIZE_CONFIG);
	}

	installHooksOnce();
	const html = marked.parse(body, { async: false }) as string;
	const sanitized = DOMPurify.sanitize(html, SANITIZE_CONFIG);

	// Mention-walk requires a real DOM. Build a detached container,
	// rewrite, return its inner HTML.
	const container = document.createElement('div');
	container.innerHTML = sanitized;
	postProcessMentions(container, members);
	return container.innerHTML;
}
