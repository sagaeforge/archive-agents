// The Markdown path for untrusted text (design 9). Runs the same pipeline the worker runs.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { propertyNames, toHtml } from './support-hast.ts';
import { linkNodeRefs, markdownToTree, sanitizeSchema } from '../src/render/pipeline.ts';
import { NODE_HREF } from '../src/render/nodeHref.ts';
import { highlightTree } from '../src/render/highlight.ts';

const html = async (md: string) => toHtml(await markdownToTree(md));

describe('raw HTML and active content never survive', () => {
  it.each([
    ['<script>alert(1)</script>', /script|alert/i],
    ['<img src=x onerror=alert(1)>', /onerror|<img/i],
    ['<iframe src="https://evil.test"></iframe>', /iframe/i],
    ['<svg onload="alert(1)"><circle r="1"/></svg>', /svg|onload/i],
    ['<div style="position:fixed" onclick="alert(1)">x</div>', /style|onclick/i],
    ['<form action="https://evil.test"><input name=pw></form>', /<form|action=/i],
    ['<link rel=stylesheet href=https://evil.test/x.css>', /<link/i],
    ['<meta http-equiv=refresh content=0>', /<meta/i],
    ['<base href=https://evil.test/>', /<base/i],
    ['<object data=x></object><embed src=x>', /<object|<embed/i],
    ['<video src=x></video><audio src=x></audio>', /<video|<audio/i],
  ])('%s', async (input, bad) => { expect(await html(input)).not.toMatch(bad); });
});

describe('links', () => {
  it.each(['[x](javascript:alert(1))', '[x](data:text/html;base64,PHNjcmlwdD4=)', '[x](vbscript:msgbox(1))', '[x](file:///etc/passwd)', '[x](mailto:a@b.test)', '[x](repo://sagae-tools/x)'])('%s loses its href', async (md) => {
    expect(await html(md)).not.toMatch(/href=/);
  });
  it('http and https stay', async () => { expect(await html('[x](https://example.test/a)')).toContain('href="https://example.test/a"'); });
  it('the sanitize stage knows only http and https for links', () => { expect(sanitizeSchema.protocols?.href).toEqual(['http', 'https']); });
  it('a title cannot break out of its attribute', async () => {
    const tree = await markdownToTree('[t](https://example.test/ "t\\" onmouseover=\\"alert(5)")');
    expect(propertyNames(tree).sort()).toEqual(['href', 'title']);
  });
  it('a raw `loupe-node:` link in the text does not survive sanitize', async () => { expect(await html(`[x](${NODE_HREF}e:a:b)`)).not.toContain(NODE_HREF); });
});

describe('images become words', () => {
  it('names the alt text and the host, and asks nothing of the network', async () => {
    const out = await html('![추적 픽셀](https://tracker.example.test/pixel.gif?kb=1)');
    expect(out).toContain('[이미지: 추적 픽셀, tracker.example.test]');
    expect(out).not.toMatch(/<img|src=/);
  });
  it('an image with no alt and no host still says something', async () => { expect(await html('![](x.png)')).toContain('[이미지: 설명 없음]'); });
});

describe('structure survives', () => {
  it('headings, tables, lists, code, GFM strike', async () => {
    const out = await html('# 제목\n\n| 열 | 값 |\n|---|---|\n| a | b |\n\n- 하나\n\n`코드` ~~지움~~');
    for (const t of ['<h1>', '<table>', '<li>', '<code>', '<del>']) expect(out).toContain(t);
  });
  it('id and name keep the clobbering prefix (footnotes)', async () => {
    const out = await html('본문[^1]\n\n[^1]: 각주');
    expect(out).toContain('id="user-content-fn-1"');
    expect(out).not.toContain('user-content-user-content');
  });
  it('no style attribute anywhere in the schema', () => {
    for (const [, list] of Object.entries(sanitizeSchema.attributes ?? {})) expect((list ?? []).map((a) => (Array.isArray(a) ? a[0] : a))).not.toContain('style');
  });
});

describe('[[id]] links in first-party bodies (C 6.2)', () => {
  const linked = async (md: string) => toHtml(linkNodeRefs(await markdownToTree(md)));
  it('a valid id links to the node, by its slug', async () => {
    const out = await linked('흐름은 [[e:project:sagae-viewer]]에서 시작한다.');
    expect(out).toContain(`href="${NODE_HREF}e:project:sagae-viewer"`);
    expect(out).toContain('>sagae-viewer</a>');
    expect(out).toContain('에서 시작한다.');
  });
  it('code stays code', async () => { expect(await linked('`[[e:a:b]]`')).not.toContain(NODE_HREF); });
  it('an id that breaks the rule stays text', async () => { expect(await linked('[[../../etc]] [[a?b=1]]')).not.toContain(NODE_HREF); });
  it('several in one line keep the text between them', async () => {
    const out = await linked('[[e:a:one]] 그리고 [[e:a:two]]');
    expect(out.match(/<a /g)).toHaveLength(2); expect(out).toContain(' 그리고 ');
  });
});

describe('Shiki after sanitize', () => {
  it('colours a known language without leaving a script or a remote resource', async () => {
    const tree = await highlightTree(await markdownToTree('```ts\nconst a: number = 1;\n```'));
    const out = toHtml(tree);
    expect(out).toContain('class="shiki');
    expect(out).toContain('const');
    expect(out).not.toMatch(/<script|src=|url\(/);
  }, 30_000);
  it('a language outside the table stays plain, even one named like a prototype key', async () => {
    for (const lang of ['nosuchlang', '__proto__', 'constructor']) {
      const tree = await highlightTree(await markdownToTree(`\`\`\`${lang}\n<b>x</b>\n\`\`\``));
      const out = toHtml(tree);
      expect(out).not.toContain('class="shiki'); expect(out).toContain('&#x3C;b>');
    }
  });
});

describe('the hostile fixture', () => {
  const fx = JSON.parse(readFileSync(new URL('../contract-sample/fixtures/kb-hostile.json', import.meta.url), 'utf8'));
  it('no Markdown body keeps a dangerous element, attribute or URL', async () => {
    for (const [id, b] of Object.entries<{ text: string }>(fx.bodies)) {
      const tree = await markdownToTree(b.text);
      const out = toHtml(tree);
      expect(out, id).not.toMatch(/<(script|iframe|svg|img|object|embed|style|form|link|meta|base)\b/i);
      expect(propertyNames(tree).filter((p) => /^on/i.test(p)), id).toEqual([]);
      expect(out, id).not.toMatch(/(href|src)="(javascript|data|vbscript):/i);
      expect(out, id).not.toContain('tracker.example.test/pixel');
    }
  });
});
