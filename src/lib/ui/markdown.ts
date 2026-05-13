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

import { marked, Renderer, type Tokens } from 'marked';
import DOMPurify, { type Config as DOMPurifyConfig } from 'dompurify';
import type { AgentInfo } from './types';

/* ---------- image rendering policy (ADR-0023) ----------------
 *
 * `<img>` was already passing through DOMPurify's defaults (the
 * tag is on its default allowlist and we never added it to
 * FORBID_TAGS). What changes with ADR-0023 is the *boundary*:
 *
 *   - src must start with `https://` (block http:, data:, blob:,
 *     and anything else by removing the src attribute when the
 *     scheme doesn't match -- DOMPurify already blocks
 *     `javascript:` etc. but we pin the contract here)
 *   - attributes allowed on <img> are exactly `src, alt, title`
 *     (no srcset, style, width, height, crossorigin, etc.)
 *   - every rendered <img> gets `loading="lazy"` and
 *     `referrerpolicy="no-referrer"` injected post-sanitize
 *   - load failures (404, CSP block, browser decode error) fall
 *     back to the literal markdown text as monospace, mirroring
 *     ADR-0022's mermaid render-failure pattern
 *
 * The first three controls live in the DOMPurify hook below.
 * The fallback handler is attached in `postProcessImages`, which
 * runs on the same DOM walk that `postProcessMentions` uses --
 * one walker, two responsibilities.
 */

/* ---------- marked configuration --------------------------- */

/**
 * Custom renderer for fenced code blocks. When the language token
 * is `mermaid` (case-insensitive), we emit a placeholder element
 * that carries the diagram source in a data-attribute. The
 * `MermaidBlock.svelte` component later finds these placeholders
 * via `querySelectorAll('pre[data-mermaid-source]')` and replaces
 * them with rendered SVG (ADR-0022).
 *
 * The source is **base64-encoded** in the data-attribute for two
 * reasons:
 *
 *   1. DOMPurify can't accidentally interpret it as HTML. The
 *      `<` / `>` / `&` characters that mermaid syntax contains
 *      pass straight through the sanitizer because they live
 *      inside an attribute value, not in text content.
 *   2. The fallback `<code>` body (visible if the renderer never
 *      runs — e.g. SSR before hydration, or while the message is
 *      still streaming) shows the escaped source as a plain code
 *      block, matching ADR-0022's streaming/fallback contract.
 *
 * Per ADR-0022 §Pipeline: interception at the parser level keeps
 * the sanitizer's view of the bubble unchanged. The mermaid source
 * never travels as HTML.
 */
const mermaidRenderer = new Renderer();
const defaultCodeRenderer = mermaidRenderer.code.bind(mermaidRenderer);
mermaidRenderer.code = function ({ text, lang, escaped }: Tokens.Code): string {
	if (typeof lang === 'string' && lang.trim().toLowerCase() === 'mermaid') {
		// btoa works on latin-1 only; encodeURIComponent → unescape
		// is the canonical "any unicode → base64" path in browsers,
		// and Buffer is available SSR-side via the marked → node path.
		const b64 = encodeBase64Utf8(text);
		const escapedText = escapeHtml(text);
		return `<pre data-mermaid-source="${b64}" class="mermaid-placeholder"><code>${escapedText}</code></pre>`;
	}
	return defaultCodeRenderer({ text, lang, escaped, type: 'code', raw: '' } as Tokens.Code);
};

function encodeBase64Utf8(s: string): string {
	if (typeof window === 'undefined' && typeof Buffer !== 'undefined') {
		return Buffer.from(s, 'utf-8').toString('base64');
	}
	// Browser path: utf-8 → percent-escapes → byte-string → btoa.
	return btoa(unescape(encodeURIComponent(s)));
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

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
	breaks: true,
	renderer: mermaidRenderer
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
	// Allow our mermaid-placeholder data-attribute through the
	// sanitizer. ADR-0022 §Pipeline relies on this so the renderer
	// component can discover placeholders post-sanitize.
	//
	// The image-fallback attributes (data-img-fallback-src,
	// data-img-fallback-alt) carry the original markdown source so
	// the onerror handler can reconstruct the literal `![alt](src)`
	// text on load failure. They live as data-* so DOMPurify keeps
	// them by default, but we list them here for audit clarity.
	ADD_ATTR: ['data-mermaid-source', 'data-img-fallback-src', 'data-img-fallback-alt'],
	// We never need raw <html>/<body> wrappers; DOMPurify will
	// honour this. Adds a strict mode for the output.
	WHOLE_DOCUMENT: false,
	RETURN_DOM_FRAGMENT: false,
	RETURN_TRUSTED_TYPE: false
};

/**
 * Belt-and-suspenders. DOMPurify already blocks `javascript:` /
 * `vbscript:` URLs and most exotic schemes; the hooks below pin
 * two additional contracts:
 *
 *  1. `<a href="data:...">` is stripped. We don't render images
 *     today's user-pasted via `<a>`, and bare `data:` links in
 *     bubble bodies are almost always confusable surfaces.
 *  2. `<img src>` is restricted to `https://` per ADR-0023 §2.
 *     Anything else (http:, data:, blob:, file:, etc.) gets the
 *     src attribute removed, leaving an alt-only `<img>` that
 *     the browser renders as the alt text. The `data-img-
 *     fallback-*` attributes carry the original markdown source
 *     so the post-process step can render a literal-text
 *     fallback even when src is intact (load-time failure path).
 *  3. `<img>` attributes are narrowed to `src, alt, title` only.
 *     Anything else (srcset, style, width, height, crossorigin,
 *     decoding, fetchpriority, ...) is removed. This is the
 *     ADR-0023 §5 attribute-allowlist guarantee.
 *
 * Hook installs once.
 */
const IMG_ALLOWED_ATTRS = new Set(['src', 'alt', 'title']);

let hooksInstalled = false;
function installHooksOnce(): void {
	if (hooksInstalled) return;
	hooksInstalled = true;
	DOMPurify.addHook('afterSanitizeAttributes', (node) => {
		if (!(node instanceof Element)) return;

		// <a href="data:..."> stripping (kept from ADR-0016).
		if (node.tagName === 'A') {
			const href = node.getAttribute('href');
			if (href && /^data:/i.test(href.trim())) {
				node.removeAttribute('href');
			}
		}

		// <img> scheme + attribute discipline (ADR-0023).
		if (node.tagName === 'IMG') {
			const img = node as HTMLImageElement;
			const src = img.getAttribute('src')?.trim() ?? '';
			const alt = img.getAttribute('alt') ?? '';

			// Stash the original (alt, src) for the load-failure
			// fallback. Done before the scheme check because we want
			// the literal text even when src was an http:// link the
			// user might want to see in the bubble for debugging.
			img.setAttribute('data-img-fallback-src', src);
			img.setAttribute('data-img-fallback-alt', alt);

			// Drop src if scheme isn't https://. Leaving the <img>
			// with only alt+fallback-data renders as alt-text in
			// browsers (existing accessibility behaviour), and the
			// post-process step will replace it with the literal
			// markdown text per ADR-0023 §4.
			if (!/^https:\/\//i.test(src)) {
				img.removeAttribute('src');
			}

			// Narrow attribute set. Walk the live NamedNodeMap by
			// snapshotting names first; removeAttribute during
			// iteration would skip entries.
			const attrNames: string[] = [];
			for (let i = 0; i < img.attributes.length; i++) {
				attrNames.push(img.attributes[i]!.name);
			}
			for (const name of attrNames) {
				const lower = name.toLowerCase();
				if (IMG_ALLOWED_ATTRS.has(lower)) continue;
				if (lower === 'data-img-fallback-src') continue;
				if (lower === 'data-img-fallback-alt') continue;
				img.removeAttribute(name);
			}
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
