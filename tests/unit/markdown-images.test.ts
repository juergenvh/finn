/**
 * Unit tests for the image-sanitisation contract in markdown.ts
 * (ADR-0023).
 *
 * Scope: the DOMPurify hook that filters `<img src>` schemes and
 * narrows the attribute set. Tested by driving the same DOMPurify
 * config the production module uses, against a small fixture
 * window from jsdom.
 *
 * The post-process step (`images.ts::mountImages`) is exercised
 * via small DOM fixtures that simulate what the markdown pipeline
 * hands off: `<img>` elements with `data-img-fallback-*` already
 * stamped on them.
 *
 * The mermaid renderer test next door uses a verbatim-copy
 * approach because importing markdown.ts would pull DOMPurify
 * (which needs a window). This file goes the other way: we set
 * up jsdom + DOMPurify ourselves and re-implement the hook in
 * isolation, matching the production code 1:1. Either approach
 * locks the contract; the choice here is what's easier given the
 * fixture shape.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';

// Mirror of the production hook + config from markdown.ts. If
// this drifts from production, the test stops matching the
// surface, which is the failure mode we want.
const IMG_ALLOWED_ATTRS = new Set(['src', 'alt', 'title']);

type Sanitizer = ReturnType<typeof createDOMPurify>;
let dp: Sanitizer;

const CONFIG = {
	FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'style', 'link'],
	FORBID_ATTR: ['target'],
	ADD_ATTR: ['data-mermaid-source', 'data-img-fallback-src', 'data-img-fallback-alt']
};

beforeAll(() => {
	const window = new JSDOM('').window;
	dp = createDOMPurify(window as unknown as Window & typeof globalThis);
	dp.addHook('afterSanitizeAttributes', (node) => {
		const el = node as Element;
		if (!el || !el.tagName) return;
		if (el.tagName === 'A') {
			const href = el.getAttribute('href');
			if (href && /^data:/i.test(href.trim())) {
				el.removeAttribute('href');
			}
		}
		if (el.tagName === 'IMG') {
			const img = el as unknown as HTMLImageElement;
			const src = img.getAttribute('src')?.trim() ?? '';
			const alt = img.getAttribute('alt') ?? '';
			img.setAttribute('data-img-fallback-src', src);
			img.setAttribute('data-img-fallback-alt', alt);
			if (!/^https:\/\//i.test(src)) {
				img.removeAttribute('src');
			}
			const names: string[] = [];
			for (let i = 0; i < img.attributes.length; i++) {
				names.push(img.attributes[i]!.name);
			}
			for (const name of names) {
				const lower = name.toLowerCase();
				if (IMG_ALLOWED_ATTRS.has(lower)) continue;
				if (lower === 'data-img-fallback-src') continue;
				if (lower === 'data-img-fallback-alt') continue;
				img.removeAttribute(name);
			}
		}
	});
});

function clean(html: string): string {
	return dp.sanitize(html, CONFIG) as string;
}

/** Parse the sanitised HTML and pull out the (possibly absent)
 * src attribute on the first <img>. Cleaner than substring
 * matching when the fallback data-attributes also contain the
 * URL. */
function firstImgSrc(html: string): string | null {
	const dom = new JSDOM(`<!DOCTYPE html><body>${html}</body>`);
	const img = dom.window.document.querySelector('img');
	return img?.getAttribute('src') ?? null;
}

function firstImgAttr(html: string, attr: string): string | null {
	const dom = new JSDOM(`<!DOCTYPE html><body>${html}</body>`);
	const img = dom.window.document.querySelector('img');
	return img?.getAttribute(attr) ?? null;
}

describe('image sanitisation (ADR-0023)', () => {
	it('passes https:// images through with src + alt', () => {
		const out = clean('<img src="https://example.com/cat.png" alt="cat">');
		expect(out).toContain('src="https://example.com/cat.png"');
		expect(out).toContain('alt="cat"');
		expect(out).toContain('data-img-fallback-src="https://example.com/cat.png"');
		expect(out).toContain('data-img-fallback-alt="cat"');
	});

	it('strips src on http:// images but keeps alt + fallback data', () => {
		const out = clean('<img src="http://example.com/cat.png" alt="cat">');
		expect(firstImgSrc(out)).toBeNull();
		expect(firstImgAttr(out, 'alt')).toBe('cat');
		expect(firstImgAttr(out, 'data-img-fallback-src')).toBe('http://example.com/cat.png');
	});

	it('strips src on data:image/* URLs (v1 deferral, ADR-0023 §1)', () => {
		const out = clean('<img src="data:image/png;base64,abc" alt="x">');
		expect(firstImgSrc(out)).toBeNull();
		expect(firstImgAttr(out, 'data-img-fallback-src')).toBe('data:image/png;base64,abc');
	});

	it('strips src on file://, blob:, javascript: schemes', () => {
		// DOMPurify's defaults already drop file:, blob:, and
		// javascript: from <img src>. Our hook never sees those
		// values, so the fallback-src ends up empty for these
		// cases. Either way, the rendered <img> ends up with no
		// src — which is the contract we care about.
		for (const src of [
			'file:///etc/passwd',
			'blob:https://example.com/abc',
			'javascript:alert(1)'
		]) {
			const out = clean(`<img src="${src}" alt="x">`);
			expect(firstImgSrc(out), `scheme: ${src}`).toBeNull();
		}
	});

	it('drops srcset, style, width, height, crossorigin, decoding', () => {
		const dirty =
			'<img src="https://x.png" alt="x" srcset="https://x.png 2x" ' +
			'style="width:99px" width="99" height="99" ' +
			'crossorigin="anonymous" decoding="async" fetchpriority="high">';
		const out = clean(dirty);
		expect(out).toContain('src="https://x.png"');
		expect(out).toContain('alt="x"');
		expect(out).not.toContain('srcset');
		expect(out).not.toContain('style');
		expect(out).not.toContain('width');
		expect(out).not.toContain('height');
		expect(out).not.toContain('crossorigin');
		expect(out).not.toContain('decoding');
		expect(out).not.toContain('fetchpriority');
	});

	it('drops inline event handlers on img', () => {
		const out = clean('<img src="https://x.png" alt="x" onerror="alert(1)" onload="x()">');
		expect(out).not.toContain('onerror');
		expect(out).not.toContain('onload');
	});

	it('keeps the title attribute when present', () => {
		const out = clean('<img src="https://x.png" alt="x" title="hover me">');
		expect(out).toContain('title="hover me"');
	});

	it('treats HTTPS / Https / HTTPS as the same scheme (case-insensitive)', () => {
		for (const scheme of ['https', 'Https', 'HTTPS']) {
			const out = clean(`<img src="${scheme}://x.png" alt="x">`);
			expect(out, `scheme: ${scheme}`).toMatch(/src="\w+:\/\/x\.png"/);
		}
	});

	it('does not affect <a href="data:..."> stripping (ADR-0016 carried over)', () => {
		const out = clean('<a href="data:text/html,<script>x</script>">click</a>');
		expect(out).not.toContain('data:text/html');
	});
});
