/**
 * Image post-processing for message bubbles (ADR-0023).
 *
 * Counterpart to `mermaid.ts::mountMermaidBlocks`. The sanitiser
 * in `markdown.ts` produces clean `<img>` elements (scheme-
 * filtered, attribute-allowlisted, with the original markdown
 * source stashed in `data-img-fallback-{src,alt}`). This module
 * walks the rendered bubble after `{@html ...}` lands and:
 *
 *   1. injects `loading=\"lazy\"` and
 *      `referrerpolicy=\"no-referrer\"` on every <img>. Both are
 *      attributes the sanitiser strips (they're not in the
 *      ADR-0023 src/alt/title allowlist) so we add them back
 *      after the sanitiser has done its work.
 *   2. attaches an `error` listener that replaces the broken
 *      <img> with a literal-markdown fallback span. Idempotent
 *      via a `data-img-mounted` marker.
 *   3. for <img> elements whose src was already removed by the
 *      sanitiser (scheme didn't match https://), runs the
 *      fallback immediately. Same visual end-state as a runtime
 *      load failure.
 *
 * Why a post-process step instead of an inline `onerror=\"...\"`
 * attribute: DOMPurify strips inline event handlers (correctly).
 * Attaching the listener after sanitisation is the cleanest way
 * to give every <img> a graceful failure mode without weakening
 * the sanitiser.
 */

/* ---------- helpers -------------------------------------------- */

/**
 * Reconstruct the literal markdown for a broken image, using the
 * stashed fallback-src/alt data-attributes. Returns the rendered
 * fallback element.
 *
 * Shape: `<span class=\"image-fallback\"><code>![alt](src)</code>
 * <span class=\"image-error-caption\">image failed to load</span>
 * </span>`. Two-line layout (the caption sits below the literal),
 * matching ADR-0023 \u00a74 (\"literal markdown + small error
 * caption\").
 */
function makeFallbackElement(img: HTMLImageElement): HTMLSpanElement {
	const src = img.getAttribute('data-img-fallback-src') ?? img.getAttribute('src') ?? '';
	const alt = img.getAttribute('data-img-fallback-alt') ?? img.getAttribute('alt') ?? '';

	const wrap = document.createElement('span');
	wrap.className = 'image-fallback';

	const code = document.createElement('code');
	code.className = 'image-fallback-source';
	code.textContent = `![${alt}](${src})`;
	wrap.appendChild(code);

	const caption = document.createElement('span');
	caption.className = 'image-error-caption';
	caption.textContent = 'image failed to load';
	wrap.appendChild(caption);

	return wrap;
}

function replaceWithFallback(img: HTMLImageElement): void {
	const wrap = makeFallbackElement(img);
	img.replaceWith(wrap);
}

/* ---------- mount entry point --------------------------------- */

/**
 * Walk `root` for unmounted <img> elements and harden them per
 * ADR-0023. Idempotent and re-entrant via the `data-img-mounted`
 * marker; a second call on the same root is a no-op.
 *
 * The four actions per <img>:
 *
 *   - if there's no `src` (sanitiser dropped it because the
 *     scheme wasn't https), replace with the literal fallback
 *     immediately
 *   - add `loading=\"lazy\"` and
 *     `referrerpolicy=\"no-referrer\"`
 *   - attach an error listener for runtime load failures
 *   - mark as mounted so we don't re-process
 */
export function mountImages(root: HTMLElement | null | undefined): void {
	if (!root || typeof window === 'undefined') return;

	const imgs = root.querySelectorAll<HTMLImageElement>('img:not([data-img-mounted])');
	if (imgs.length === 0) return;

	for (const img of Array.from(imgs)) {
		img.setAttribute('data-img-mounted', '1');

		// Sanitiser-dropped src \u2192 immediate fallback.
		if (!img.getAttribute('src')) {
			replaceWithFallback(img);
			continue;
		}

		// Privacy + perf hardening that the sanitiser stripped
		// (only src/alt/title survive its allowlist per ADR-0023).
		img.setAttribute('loading', 'lazy');
		img.setAttribute('referrerpolicy', 'no-referrer');

		// Runtime load-failure fallback. One-shot listener; the
		// fallback element replaces the <img> so there's nothing
		// to re-fire on.
		img.addEventListener(
			'error',
			() => {
				replaceWithFallback(img);
			},
			{ once: true }
		);
	}
}
