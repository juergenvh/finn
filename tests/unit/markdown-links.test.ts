/**
 * Markdown link rendering — `target=_blank` injection contract.
 *
 * Covers the 2026-05-21 update to `src/lib/ui/markdown.ts` that
 * makes external links open in a new tab so clicking a link in a
 * bubble does not tear down the current finn session (which may
 * be mid-stream on a long agent reply).
 *
 * The actual `markdown.ts` module bundles `marked` + `DOMPurify`
 * + a DOM mention-walk. The mention-walk needs a live `document`,
 * which we don't want to spin up here. Instead this suite mirrors
 * the same DOMPurify hook the production code installs and runs
 * it through jsdom, which is the same shape the
 * `markdown-images.test.ts` suite uses for its concern.
 *
 * If the production hook diverges from the one mirrored here, the
 * fix is to update both — the next time someone changes link
 * policy, both files must move together. The contract under test
 * is documented in `markdown.ts`'s `<a>`-policy comment.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import { marked } from 'marked';

type Sanitizer = ReturnType<typeof createDOMPurify>;
let dp: Sanitizer;

const CONFIG = {
	FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'style', 'link'],
	FORBID_ATTR: [] as string[],
	ADD_ATTR: ['data-mermaid-source', 'data-img-fallback-src', 'data-img-fallback-alt']
};

beforeAll(() => {
	const window = new JSDOM('').window;
	dp = createDOMPurify(window as unknown as Window & typeof globalThis);
	dp.addHook('afterSanitizeAttributes', (node) => {
		const el = node as Element;
		if (!el || !el.tagName) return;
		if (el.tagName === 'A') {
			const href = el.getAttribute('href')?.trim() ?? '';
			if (/^data:/i.test(href)) {
				el.removeAttribute('href');
			} else if (href.length > 0 && !href.startsWith('#')) {
				el.setAttribute('target', '_blank');
				el.setAttribute('rel', 'noopener noreferrer');
			}
		}
	});
});

function render(md: string): string {
	const html = marked.parse(md, { async: false }) as string;
	return dp.sanitize(html, CONFIG);
}

describe('markdown link policy', () => {
	it('opens https:// links in a new tab', () => {
		const out = render('[finn](https://github.com/juergenvh/finn)');
		expect(out).toContain('target="_blank"');
		expect(out).toContain('rel="noopener noreferrer"');
		expect(out).toContain('href="https://github.com/juergenvh/finn"');
	});

	it('opens http:// links in a new tab', () => {
		const out = render('[old](http://example.com)');
		expect(out).toContain('target="_blank"');
		expect(out).toContain('rel="noopener noreferrer"');
	});

	it('opens mailto: links in a new tab (so the default mail handler opens, not in-place)', () => {
		const out = render('[mail](mailto:nobody@example.com)');
		expect(out).toContain('target="_blank"');
		expect(out).toContain('rel="noopener noreferrer"');
	});

	it('leaves in-page hash anchors as in-place navigation', () => {
		const out = render('[Top](#top)');
		expect(out).not.toContain('target=');
		expect(out).not.toContain('rel="noopener');
		expect(out).toContain('href="#top"');
	});

	it('strips data: hrefs (kept from the original ADR-0016 policy)', () => {
		const out = render('[evil](data:text/html,<script>alert(1)</script>)');
		// href is gone; the link becomes an anchor without target.
		expect(out).not.toContain('href="data:');
		expect(out).not.toContain('target="_blank"');
	});

	it('still wraps an autolinked URL in target=_blank', () => {
		// marked with `gfm: true` would normally autolink raw URLs;
		// here we use the explicit form to stay decoupled from gfm
		// configuration in this test.
		const out = render('See <https://docs.openclaw.ai/>.');
		expect(out).toContain('target="_blank"');
		expect(out).toContain('rel="noopener noreferrer"');
	});

	it('does not inject target onto bare-fragment links produced as relative anchors', () => {
		// Edge: marked may produce `href=""` from `[x]()`; we treat
		// empty hrefs as in-place too (no `length > 0` branch).
		const out = render('[empty]()');
		expect(out).not.toContain('target="_blank"');
	});
});
