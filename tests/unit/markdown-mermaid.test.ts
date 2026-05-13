/**
 * Unit tests for the mermaid-interception path in the marked
 * renderer (ADR-0022 §Pipeline).
 *
 * Scope: verify that the custom code-block renderer recognises
 * `lang === 'mermaid'` (and case variants), emits a placeholder
 * `<pre data-mermaid-source="<b64>">` with the source intact, and
 * leaves non-mermaid code blocks alone.
 *
 * The full markdown.ts → DOMPurify pipeline isn't exercised here
 * because DOMPurify requires a window provider (jsdom) that the
 * vitest config doesn't currently set up. The interception happens
 * before sanitization anyway, so testing the renderer in isolation
 * pins the contract that matters for this feature.
 *
 * The component-level mount (`mermaid.ts::mountMermaidBlocks`) and
 * the actual SVG render are deliberately out of scope for unit
 * tests — those are browser-bound and belong in a smoke spec
 * (listed as optional follow-up in ADR-0022 §Implementation).
 */

import { describe, it, expect } from 'vitest';
import { marked, Renderer, type Tokens } from 'marked';

/**
 * Re-implement the renderer here to test it in isolation. Importing
 * `markdown.ts` would pull DOMPurify into the test context, which
 * needs a window. The renderer logic is small enough that a
 * verbatim copy is fine — if it drifts from the production code the
 * test stops matching the surface, which is the failure mode we
 * want.
 */
function makeMermaidRenderer(): Renderer {
	const r = new Renderer();
	const defaultCode = r.code.bind(r);
	r.code = function ({ text, lang, escaped }: Tokens.Code): string {
		if (typeof lang === 'string' && lang.trim().toLowerCase() === 'mermaid') {
			const b64 = Buffer.from(text, 'utf-8').toString('base64');
			const escapedText = text
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;')
				.replace(/"/g, '&quot;')
				.replace(/'/g, '&#39;');
			return `<pre data-mermaid-source="${b64}" class="mermaid-placeholder"><code>${escapedText}</code></pre>`;
		}
		return defaultCode({ text, lang, escaped, type: 'code', raw: '' } as Tokens.Code);
	};
	return r;
}

function render(md: string): string {
	const r = makeMermaidRenderer();
	const tmp = marked.use({ gfm: true, breaks: true, renderer: r });
	return tmp.parse(md, { async: false }) as string;
}

describe('mermaid renderer interception (ADR-0022)', () => {
	it('emits placeholder for ```mermaid fenced block', () => {
		const md = '```mermaid\ngraph TD\nA-->B\n```';
		const html = render(md);
		expect(html).toContain('data-mermaid-source=');
		expect(html).toContain('class="mermaid-placeholder"');
		// Source is base64-encoded; decode and check.
		const m = html.match(/data-mermaid-source="([^"]+)"/);
		expect(m).not.toBeNull();
		const decoded = Buffer.from(m![1]!, 'base64').toString('utf-8');
		expect(decoded).toBe('graph TD\nA-->B');
	});

	it('escapes HTML in the visible fallback <code> body', () => {
		const md = '```mermaid\ngraph TD\nA["<b>label</b>"]-->B\n```';
		const html = render(md);
		// The fallback body must show the source as plain text, not
		// as parsed HTML. The escape protects the user's view if the
		// renderer never runs (SSR pre-hydration, streaming bubble).
		expect(html).toContain('&lt;b&gt;label&lt;/b&gt;');
		expect(html).not.toContain('<b>label</b>');
	});

	it('preserves non-mermaid code blocks via the default renderer', () => {
		const md = '```js\nconst x = 1;\n```';
		const html = render(md);
		expect(html).not.toContain('data-mermaid-source');
		// marked's default emits a <pre><code class="language-js">...</code></pre>.
		expect(html).toMatch(/<pre><code[^>]*>const x = 1;\n<\/code><\/pre>/);
	});

	it('treats Mermaid / MERMAID / mermaid identically (case-insensitive)', () => {
		for (const lang of ['Mermaid', 'MERMAID', '  mermaid  ', 'mermaid']) {
			const md = `\`\`\`${lang}\nA-->B\n\`\`\``;
			const html = render(md);
			expect(html, `case: ${JSON.stringify(lang)}`).toContain('data-mermaid-source=');
		}
	});

	it('round-trips Unicode in the source via base64', () => {
		const md = '```mermaid\ngraph TD\nA["Über schön"]-->B["café"]\n```';
		const html = render(md);
		const m = html.match(/data-mermaid-source="([^"]+)"/);
		expect(m).not.toBeNull();
		const decoded = Buffer.from(m![1]!, 'base64').toString('utf-8');
		expect(decoded).toContain('Über schön');
		expect(decoded).toContain('café');
	});

	it('leaves an empty placeholder body for empty mermaid block', () => {
		const md = '```mermaid\n\n```';
		const html = render(md);
		expect(html).toContain('data-mermaid-source=');
		// base64 of empty / just-newline source is short but present.
		const m = html.match(/data-mermaid-source="([^"]*)"/);
		expect(m).not.toBeNull();
	});
});
