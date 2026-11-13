// extension/inject.js functions run in the page via executeScript, which
// serialises them with toString(). page.evaluate(fn) does exactly the same, so
// these tests also enforce the file's "no outside references" constraint: a
// function that leaks a module-scope reference fails here with a ReferenceError.
import { test, expect } from '@playwright/test';
import {
  getCapabilities, runAnalysis, applySnippet, clearSnippet, probeSelector, flashSelector,
  unreadableSheets, provideSheets,
} from '../../extension/inject.js';
import { serve, doc, inPage, OTHER_ORIGIN } from '../helpers.mjs';

const CSS = `
  .card { padding: 8px }
  .card:hover .title { color: rgb(255, 0, 0) }
  .trap:hover .w { color: red } #box .w { color: green }
`;
const BODY = `
  <div class="card" id="card"><a class="title" id="t" style="padding: 1px">title</a></div>
  <div id="box"><div class="trap"><span class="w" id="w">w</span></div></div>
  <div id="plain">no hover here</div>
  <x-host id="host"></x-host>
  <script>
    customElements.define('x-host', class extends HTMLElement { connectedCallback() {
      const r = this.attachShadow({ mode: 'open' });
      r.innerHTML = '<style>.in:hover{color:rgb(0,0,255)}</style><span class="in">in</span><span class="in">in2</span>';
    }});
  </script>`;

test.describe('runAnalysis', () => {
  test.beforeEach(async ({ page }) => {
    await serve(page, doc(CSS, BODY));
  });

  test('returns a structured-cloneable projection: apply-only snippet plus the eval-free plan', async ({ page }) => {
    const r = await page.evaluate(runAnalysis, '#t');
    expect(r.ok).toBe(true);
    expect(r.empty).toBe(false);
    expect(r.verified).toBe(true);
    expect(r.verification).toBeNull(); // null == passed
    expect(r.hoverRootDesc).toBe('div#card.card');
    expect(r.affected[0].decls[0]).toEqual(['color', 'rgb(255, 0, 0)', false]);
    // apply-only for the user; plain data for the panel button
    expect(r.snippet).not.toContain('clearHover');
    expect(r.plan).toEqual({ targets: [[['#t'], { color: ['rgb(255, 0, 0)', ''] }]], hosts: [], sheets: [] });
  });

  test('distinguishes "no hover rules" from "hover loses the cascade"', async ({ page }) => {
    const none = await page.evaluate(runAnalysis, '#plain');
    expect(none).toMatchObject({ ok: true, empty: true, matchedButNoEffect: false });
    const loses = await page.evaluate(runAnalysis, '#w');
    expect(loses).toMatchObject({ ok: true, empty: true, matchedButNoEffect: true });
  });

  test('reports invalid and non-matching selectors as errors, not throws', async ({ page }) => {
    expect(await page.evaluate(runAnalysis, '#t[')).toMatchObject({ ok: false, error: expect.stringMatching(/^Invalid selector/) });
    expect(await page.evaluate(runAnalysis, '#nope')).toMatchObject({ ok: false, error: 'Selector matched nothing on this page.' });
    expect(await page.evaluate(runAnalysis, '   ')).toMatchObject({ ok: false });
  });

  test('resolves >>> shadow paths', async ({ page }) => {
    const r = await page.evaluate(runAnalysis, '#host >>> span.in:nth-of-type(2)');
    expect(r.ok).toBe(true);
    expect(r.affected).toHaveLength(1);
  });

  test('says notInjected when the library global is gone', async ({ page }) => {
    await page.evaluate(() => delete window.cssHoverToJS);
    expect(await page.evaluate(runAnalysis, '#t')).toMatchObject({ ok: false, notInjected: true });
  });

  test('does not leave its own marker class in descriptions while a hover is applied', async ({ page }) => {
    const r = await page.evaluate(runAnalysis, '#t');
    await page.evaluate(applySnippet, r.plan);
    const again = await page.evaluate(runAnalysis, '#t');
    expect(JSON.stringify(again)).not.toContain('cssh-on');
  });
});

test.describe('cross-origin stylesheets (Microsoft, CNN)', () => {
  const SHEET = `${OTHER_ORIGIN}/css/s.css`;
  const IMPORTED = `${OTHER_ORIGIN}/css/more.css`;
  test.beforeEach(async ({ page }) => {
    await serve(
      page,
      doc('.x { color: rgb(0, 0, 0) }', '<a id="a" class="x">x</a> <b id="b" class="y">y</b>', {
        head: `<link rel="stylesheet" href="${SHEET}"><style>@import "${IMPORTED}";</style>`,
      }),
      {
        files: {
          [SHEET]: { body: '.x:hover { color: rgb(255, 0, 0); background: url(img/bg.png) }' },
          [IMPORTED]: { body: '.y:hover { color: rgb(0, 0, 255) }' },
        },
      }
    );
  });

  test('without the text they are flagged as incomplete', async ({ page }) => {
    const r = await page.evaluate(runAnalysis, '#a');
    expect(r.ok).toBe(true);
    // The real page DOES change on hover, but the analyzer cannot see the rule.
    expect(r.empty).toBe(true);
    expect(r.incomplete.join()).toMatch(/Cross-origin stylesheet is unreadable/);
  });

  test('unreadableSheets lists linked and @imported sheets', async ({ page }) => {
    expect((await page.evaluate(unreadableSheets)).sort()).toEqual([IMPORTED, SHEET].sort());
  });

  test('provided text is analysed in place, verified, and no longer flagged', async ({ page }) => {
    const body = { [SHEET]: '.x:hover { color: rgb(255, 0, 0); background: url(img/bg.png) }', [IMPORTED]: '.y:hover { color: rgb(0, 0, 255) }' };
    expect((await page.evaluate(provideSheets, body)).sort()).toEqual([IMPORTED, SHEET].sort());
    expect(await page.evaluate(unreadableSheets)).toEqual([]);
    for (const sel of ['#a', '#b']) {
      const r = await page.evaluate(runAnalysis, sel);
      expect(r.empty, sel).toBe(false);
      expect(r.incomplete, sel).toEqual([]);
      expect(r.verification, sel).toBeNull(); // passed
    }
    // relative url()s are resolved against the stylesheet, not the page
    const r = await page.evaluate(runAnalysis, '#a');
    expect(r.snippet).toContain(`${OTHER_ORIGIN}/css/img/bg.png`);
  });

  test('verify sees what the CSSOM cannot serialise in a provided sheet (Microsoft nav underline)', async ({ page }) => {
    // Ground truth for provided sheets is parsed from the source text, not rebuilt
    // from cssText -- which reads this rule back as "text-decoration-line: ;" and
    // so used to make verify pass on a snippet with no underline.
    const css = '.x:hover { text-decoration: underline var(--c, red); text-decoration-thickness: 2px }';
    await page.evaluate(provideSheets, { [SHEET]: css, [IMPORTED]: '' });
    const r = await page.evaluate(runAnalysis, '#a');
    expect(r.verification).toBeNull(); // passed
    expect(r.affected[0].decls.map(([p, v]) => `${p}:${v}`)).toContain('text-decoration-line:underline');
  });
});

test.describe('closed shadow roots', () => {
  test.beforeEach(async ({ page }) => {
    await serve(
      page,
      doc('.b:hover { color: rgb(255, 0, 0) }', '<x-host id="h"><button class="b" id="b">b</button></x-host> <x-empty class="b" id="e">e</x-empty>')
    );
  });

  test('the closed hosts the extension found (via chrome.dom) are what gets reported', async ({ page }) => {
    const found = await page.evaluate(`(${runAnalysis})('#b', { closedShadowHosts: ['x-host#h'] })`);
    expect(found.incomplete.join()).toMatch(/closed shadow root.*x-host#h/);
  });

  test("an explicit list replaces the library's guess", async ({ page }) => {
    // Without help the library guesses: an empty hyphenated element on the chain.
    const guessed = await page.evaluate(runAnalysis, '#e');
    expect(guessed.incomplete.join()).toMatch(/closed shadow root.*x-empty#e/);
    const told = await page.evaluate(`(${runAnalysis})('#e', { closedShadowHosts: [] })`);
    expect(told.incomplete).toEqual([]);
  });
});

test.describe('page CSP without unsafe-eval', () => {
  test.beforeEach(async ({ page }) => {
    await serve(page, doc(CSS, BODY), {
      headers: { 'Content-Security-Policy': "script-src 'self' 'unsafe-inline'" },
    });
  });

  test('control: inPage() really runs under the CSP (page.evaluate would not)', async ({ page }) => {
    const probe = () => { try { return new Function('return 1')(); } catch (e) { return e.name; } };
    expect(await page.evaluate(probe)).toBe(1);
    expect(await inPage(page, probe)).toBe('EvalError');
  });

  test('getCapabilities reports the library version', async ({ page }) => {
    expect(await inPage(page, getCapabilities)).toEqual({ version: '1.1.0' });
  });

  test('analysis is still verified -- through the eval-free runtime', async ({ page }) => {
    const r = await inPage(page, runAnalysis, '#t');
    expect(r).toMatchObject({ ok: true, verified: true, verification: null });
    expect(r.snippet).toBeTruthy();
    const checked = await inPage(page, () => window.cssHoverToJS(document.getElementById('t'), { verify: true, log: false }).verification.checked);
    expect(checked).toBe('plan');
  });

  test('apply and clear work, with the style attribute restored byte-for-byte', async ({ page }) => {
    const r = await inPage(page, runAnalysis, '#t');
    const before = await page.evaluate(() => document.getElementById('t').getAttribute('style'));
    expect(await inPage(page, applySnippet, r.plan)).toEqual({ ok: true });
    expect(await page.evaluate(() => getComputedStyle(document.getElementById('t')).color)).toBe('rgb(255, 0, 0)');
    expect(await inPage(page, clearSnippet)).toEqual({ ok: true });
    expect(await page.evaluate(() => document.getElementById('t').getAttribute('style'))).toBe(before);
  });
});

test.describe('apply / clear', () => {
  test.beforeEach(async ({ page }) => {
    await serve(page, doc(CSS, BODY));
  });

  const styleOf = (page) => page.evaluate(() => document.getElementById('t').getAttribute('style'));
  const color = (page) => page.evaluate(() => getComputedStyle(document.getElementById('t')).color);

  test('apply forces the hover state and clear restores the style attribute byte-for-byte', async ({ page }) => {
    const before = await styleOf(page);
    const r = await page.evaluate(runAnalysis, '#t');
    expect(await page.evaluate(applySnippet, r.plan)).toEqual({ ok: true });
    expect(await color(page)).toBe('rgb(255, 0, 0)');
    expect(await page.evaluate(clearSnippet)).toEqual({ ok: true });
    expect(await styleOf(page)).toBe(before);
    expect(await page.evaluate(clearSnippet)).toEqual({ ok: true }); // idempotent
  });

  test('applying a second snippet clears the first instead of orphaning it', async ({ page }) => {
    const before = await styleOf(page);
    const r = await page.evaluate(runAnalysis, '#t');
    await page.evaluate(applySnippet, r.plan);
    await page.evaluate(applySnippet, r.plan);
    await page.evaluate(clearSnippet);
    expect(await styleOf(page)).toBe(before);
  });

  test('apply says notInjected when the library is gone, so the worker re-injects', async ({ page }) => {
    const r = await page.evaluate(runAnalysis, '#t');
    await page.evaluate(() => delete window.cssHoverToJS);
    expect(await page.evaluate(applySnippet, r.plan)).toMatchObject({ ok: false, notInjected: true });
  });

  test('clear with nothing applied is an error, not a throw', async ({ page }) => {
    expect(await page.evaluate(clearSnippet)).toMatchObject({ ok: false, error: expect.stringMatching(/Nothing to clear/) });
  });
});

test.describe('probeSelector / flashSelector', () => {
  test.beforeEach(async ({ page }) => {
    await serve(page, doc(CSS, BODY));
  });

  test('counts matches, including the last segment of a shadow path', async ({ page }) => {
    expect(await page.evaluate(probeSelector, 'a')).toMatchObject({ ok: true, count: 1, desc: 'a#t.title' });
    expect(await page.evaluate(probeSelector, '#host >>> .in')).toMatchObject({ ok: true, count: 2 });
    expect(await page.evaluate(probeSelector, '#nope >>> .in')).toMatchObject({ ok: true, count: 0 });
    expect(await page.evaluate(probeSelector, 'a[')).toMatchObject({ ok: false });
  });

  test('flash never writes to the element and removes its overlay', async ({ page }) => {
    const before = await page.evaluate(() => document.getElementById('t').outerHTML);
    // two arguments: call through the serialised source, as executeScript does
    expect(await page.evaluate(`(${flashSelector})('#t', 1500)`)).toEqual({ ok: true });
    expect(await page.locator('#__cssh-flash').count()).toBe(1);
    expect(await page.evaluate(() => document.getElementById('t').outerHTML)).toBe(before);
    await expect(page.locator('#__cssh-flash')).toHaveCount(0);
  });
});
