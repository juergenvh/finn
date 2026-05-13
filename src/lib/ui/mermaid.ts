/**
 * Mermaid diagram rendering for message bubbles (ADR-0022).
 *
 * Two responsibilities split into pure functions so the component
 * boundary stays thin:
 *
 *   - `mountMermaidBlocks(root)` discovers
 *     `<pre data-mermaid-source="<b64>">` placeholders that
 *     `markdown.ts` emitted and replaces them with rendered SVG
 *     (or a graceful fallback). Idempotent: a placeholder already
 *     replaced is skipped on re-invocation.
 *
 *   - `setMermaidTheme(theme)` re-renders all visible diagrams when
 *     the prefers-color-scheme media query flips. Stable cache keys
 *     mean cached SVGs survive theme cycles.
 *
 * Cache key: `(source, theme, mermaidVersion)`. The version
 * invalidates everything on a Mermaid library upgrade, since the
 * same source can render differently across versions and a stale
 * cache would hide regressions (ADR-0022 \u00a7Theming).
 *
 * Sanitization is three layers (ADR-0022 \u00a7Security):
 *   1. pre-parse escape of <, >, & inside node labels
 *   2. Mermaid `securityLevel: 'strict'` (its own DOMPurify pass,
 *      htmlLabels disabled)
 *   3. post-render DOMPurify with an explicit SVG allowlist
 */

import DOMPurify from 'dompurify';

/* ---------- types ---------------------------------------------- */

type MermaidApi = {
	initialize: (cfg: Record<string, unknown>) => void;
	render: (id: string, source: string) => Promise<{ svg: string }>;
	parse?: (source: string) => Promise<unknown>;
	mermaidAPI?: { setConfig: (cfg: Record<string, unknown>) => void };
};

type Theme = 'light' | 'dark';

/* ---------- module state --------------------------------------- */

let mermaidPromise: Promise<MermaidApi> | null = null;
let mermaidVersion = 'unknown';
let currentTheme: Theme = 'dark';

/** In-memory cache, keyed `<theme>:<version>:<source-hash>`. */
const svgCache = new Map<string, string>();

/** Counter for unique render ids per page-life. Mermaid requires
 * a DOM-safe id; we just give it an incrementing one. */
let renderId = 0;

/** Live placeholders we've already mounted, so theme changes can
 * re-render them in place without re-walking the entire DOM. Weak
 * so detached nodes get GC'd naturally when bubbles unmount. */
const mountedBlocks = new Set<HTMLPreElement>();

/* ---------- post-render DOMPurify allowlist -------------------- */

/**
 * Explicit SVG allowlist for the third sanitizer layer. The list
 * is conservative \u2014 entries can be added empirically if Mermaid
 * legitimately emits something we filtered out, but we'd rather
 * see a missing element in the SVG than a hole in the sanitizer.
 *
 * `foreignObject` is on the list only because Mermaid still emits
 * it for some non-HTML cases (e.g. measuring); `securityLevel:
 * 'strict'` already prevents its use for HTML labels.
 */
const SVG_ALLOWED_TAGS = [
	'svg',
	'g',
	'path',
	'rect',
	'circle',
	'ellipse',
	'line',
	'polyline',
	'polygon',
	'text',
	'tspan',
	'defs',
	'marker',
	'use',
	'foreignObject',
	'style',
	'title',
	'desc'
];

const SVG_ALLOWED_ATTRS = [
	'class',
	'id',
	'd',
	'x',
	'y',
	'x1',
	'y1',
	'x2',
	'y2',
	'cx',
	'cy',
	'r',
	'rx',
	'ry',
	'width',
	'height',
	'viewBox',
	'preserveAspectRatio',
	'xmlns',
	'xmlns:xlink',
	'fill',
	'stroke',
	'stroke-width',
	'stroke-dasharray',
	'stroke-linecap',
	'stroke-linejoin',
	'transform',
	'text-anchor',
	'dominant-baseline',
	'alignment-baseline',
	'font-family',
	'font-size',
	'font-weight',
	'style',
	'marker-end',
	'marker-start',
	'marker-mid',
	'orient',
	'refX',
	'refY',
	'markerWidth',
	'markerHeight',
	'markerUnits',
	'patternUnits',
	'points',
	'href',
	'xlink:href',
	'opacity',
	'fill-opacity',
	'stroke-opacity'
];

function sanitizeSvg(svg: string): string {
	return DOMPurify.sanitize(svg, {
		ALLOWED_TAGS: SVG_ALLOWED_TAGS,
		ALLOWED_ATTR: SVG_ALLOWED_ATTRS,
		// Required so DOMPurify keeps SVG namespacing instead of
		// stripping the whole tree as "weird HTML".
		USE_PROFILES: { svg: true, svgFilters: false }
	}) as string;
}

/* ---------- mermaid lazy load ---------------------------------- */

async function loadMermaid(): Promise<MermaidApi> {
	if (mermaidPromise) return mermaidPromise;
	mermaidPromise = (async () => {
		const mod = await import('mermaid');
		// `mermaid` ships as both default and named export across
		// versions; defensively reach for both.
		const mermaid = (mod.default ?? (mod as unknown as MermaidApi)) as MermaidApi;
		// Best-effort version capture for the cache key.
		const pkgVersion = (mod as unknown as { version?: string }).version;
		if (typeof pkgVersion === 'string') mermaidVersion = pkgVersion;
		applyConfig(mermaid, currentTheme);
		return mermaid;
	})();
	return mermaidPromise;
}

function applyConfig(mermaid: MermaidApi, theme: Theme): void {
	mermaid.initialize({
		startOnLoad: false,
		securityLevel: 'strict',
		theme: theme === 'dark' ? 'dark' : 'default',
		// Discourage Mermaid's own logging on parse failures \u2014 we
		// surface the error inline ourselves.
		logLevel: 5,
		flowchart: { htmlLabels: false },
		sequence: { useMaxWidth: true },
		gantt: { useMaxWidth: true }
	});
}

/* ---------- helpers -------------------------------------------- */

/**
 * Pre-escape `<`, `>`, `&` in label-bearing positions. Mermaid's
 * parser tolerates the entity forms in node labels; we apply this
 * broadly as the first defense layer before the parse step.
 *
 * Conservative: this also escapes occurrences inside structural
 * keywords (e.g. `--\u003e` becomes `-->`), so we restrict to text
 * inside `[...]`, `(...)`, `{...}`, `"..."` and after a `:` on
 * sequence/state arrows. Anything outside those positions is
 * Mermaid syntax proper and must stay verbatim.
 *
 * For v1 we use a stricter regex that targets the common label
 * containers; edge cases that we miss still get caught by the
 * other two layers.
 */
function preEscapeLabels(source: string): string {
	const escapeRun = (s: string): string =>
		s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

	return source
		// Bracket-style labels: A[Some <text>] / A(Some <text>) / A{Some <text>}
		.replace(/(\[|\(|\{)([^\]\)\}]*?)(\]|\)|\})/g, (_, open: string, inner: string, close: string) =>
			`${open}${escapeRun(inner)}${close}`
		)
		// Quoted strings (used for labels with spaces / special chars).
		.replace(/"([^"]*)"/g, (_, inner: string) => `"${escapeRun(inner)}"`);
}

function hashStr(s: string): string {
	// Tiny non-cryptographic hash. Cache key only needs identity,
	// not collision-resistance \u2014 the source itself is in the key
	// implicitly (it's the input to the renderer).
	let h = 5381;
	for (let i = 0; i < s.length; i++) {
		h = ((h << 5) + h) ^ s.charCodeAt(i);
	}
	return (h >>> 0).toString(36);
}

function cacheKey(source: string, theme: Theme): string {
	return `${theme}:${mermaidVersion}:${hashStr(source)}:${source.length}`;
}

function decodeBase64Utf8(b64: string): string {
	if (typeof window === 'undefined' && typeof Buffer !== 'undefined') {
		return Buffer.from(b64, 'base64').toString('utf-8');
	}
	return decodeURIComponent(escape(atob(b64)));
}

/**
 * Detect the current preferred colour scheme. Defaults to dark
 * when the media query is unavailable (SSR, tests) \u2014 matches the
 * finn UI's dominant theme.
 */
function detectTheme(): Theme {
	if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
		return 'dark';
	}
	return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/* ---------- requestIdleCallback shim --------------------------- */

type IdleHandle = number;

function idle(cb: () => void): IdleHandle {
	const w = window as unknown as {
		requestIdleCallback?: (cb: () => void) => IdleHandle;
	};
	if (typeof w.requestIdleCallback === 'function') {
		return w.requestIdleCallback(cb);
	}
	return window.setTimeout(cb, 0) as unknown as IdleHandle;
}

/* ---------- core renderer -------------------------------------- */

async function renderSource(source: string, theme: Theme): Promise<string> {
	const key = cacheKey(source, theme);
	const cached = svgCache.get(key);
	if (cached) return cached;

	const mermaid = await loadMermaid();
	applyConfig(mermaid, theme);

	const escaped = preEscapeLabels(source);
	const id = `mermaid-${++renderId}`;

	const { svg } = await mermaid.render(id, escaped);
	const safe = sanitizeSvg(svg);
	svgCache.set(key, safe);
	return safe;
}

/* ---------- placeholder mounting ------------------------------- */

/**
 * Walk `root` for unrendered mermaid placeholders and render them.
 * Idempotent and re-entrant: already-mounted blocks are skipped via
 * the `data-mermaid-mounted` marker; calling this twice in quick
 * succession on the same root is a no-op for the second call.
 *
 * The fade transition (ADR-0022 \u00a7Streaming) is implemented as a
 * class swap: the rendered SVG container gets `.mermaid-rendered`
 * with opacity 0 \u2192 1 over 150ms after the actual SVG is in the
 * DOM. The original `<pre>` placeholder stays in the tree but is
 * marked done so a second pass doesn't re-render.
 */
export function mountMermaidBlocks(root: HTMLElement | null | undefined): void {
	if (!root || typeof window === 'undefined') return;
	const theme = detectTheme();
	currentTheme = theme;

	const placeholders = root.querySelectorAll<HTMLPreElement>(
		'pre[data-mermaid-source]:not([data-mermaid-mounted])'
	);
	if (placeholders.length === 0) return;

	// Sequential rendering keeps the main thread responsive between
	// diagrams \u2014 we yield via requestIdleCallback per-diagram so a
	// bubble with 10 diagrams doesn't lock for a second straight.
	const queue: HTMLPreElement[] = Array.from(placeholders);

	const processNext = (): void => {
		const placeholder = queue.shift();
		if (!placeholder) return;
		void renderOnePlaceholder(placeholder, theme).finally(() => {
			if (queue.length > 0) idle(processNext);
		});
	};
	idle(processNext);
}

async function renderOnePlaceholder(placeholder: HTMLPreElement, theme: Theme): Promise<void> {
	const b64 = placeholder.getAttribute('data-mermaid-source');
	if (!b64) return;
	placeholder.setAttribute('data-mermaid-mounted', '1');

	let source: string;
	try {
		source = decodeBase64Utf8(b64);
	} catch {
		// Malformed payload \u2014 leave the placeholder as a code block.
		return;
	}

	try {
		const svg = await renderSource(source, theme);
		const container = document.createElement('div') as HTMLDivElement & {
			__mermaidSource?: string;
		};
		container.className = 'mermaid-rendered';
		container.innerHTML = svg;
		container.__mermaidSource = source;

		// Replace placeholder, opacity transition for the swap.
		container.style.opacity = '0';
		placeholder.replaceWith(container);
		mountedBlocks.add(placeholder);
		// Force a layout, then transition to 1. The browser collapses
		// rAFs around the new node, so reading offsetHeight here is
		// the standard trick to commit the initial opacity.
		// eslint-disable-next-line @typescript-eslint/no-unused-expressions
		container.offsetHeight;
		container.style.transition = 'opacity 150ms ease-out';
		container.style.opacity = '1';
	} catch (err) {
		// Parse / render failure \u2014 keep the code-block visible but
		// stamp a small error caption beneath it. The fallback render
		// path is "the placeholder is itself a code-block" (ADR-0022
		// \u00a7Fallback), so we just append the error.
		const errLine = document.createElement('div');
		errLine.className = 'mermaid-error';
		const msg = err instanceof Error ? err.message : 'render failed';
		errLine.textContent = `mermaid: ${msg}`;
		placeholder.insertAdjacentElement('afterend', errLine);
	}
}

/* ---------- theme reaction ------------------------------------- */

let themeListenerInstalled = false;

/** Install a one-time MediaQueryList listener for dark/light flips.
 * On change, every mounted block re-renders against the new theme. */
export function installThemeListener(): void {
	if (themeListenerInstalled) return;
	if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
	themeListenerInstalled = true;
	const mq = window.matchMedia('(prefers-color-scheme: dark)');
	const onChange = (): void => {
		const next: Theme = mq.matches ? 'dark' : 'light';
		if (next === currentTheme) return;
		currentTheme = next;
		// Re-render every mounted block; they live inside the page,
		// so a fresh querySelectorAll on document.body picks them up.
		// (Some may have unmounted in the meantime; querySelectorAll
		// returns only live nodes.)
		const rendered = document.querySelectorAll<HTMLDivElement>('.mermaid-rendered');
		for (const node of Array.from(rendered)) {
			const original = (node as HTMLDivElement & { __mermaidSource?: string }).__mermaidSource;
			if (!original) continue;
			void renderSource(original, next).then((svg) => {
				node.innerHTML = svg;
			});
		}
	};
	if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
	else mq.addListener(onChange);
}
