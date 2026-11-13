// Patterns lifted from the live-site sweep (Wikipedia, CNN, Apple, GitHub, MDN,
// NASA, w3schools, Microsoft, BBC, Airbnb), reduced to minimal pages. Each test
// names the site the pattern came from.
import { test, expect } from '@playwright/test';
import { serve, doc, analyze } from '../helpers.mjs';

async function run(page, css, body, sel, opts) {
  await serve(page, doc(css, body));
  return analyze(page, sel, opts);
}

const realHoverColor = async (page, sel) => {
  const box = await page.locator(sel).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const c = await page.locator(sel).evaluate((e) => getComputedStyle(e).color);
  await page.mouse.move(-10, -10);
  return c;
};

test('CNN: hover that re-declares an unchanged color + text-decoration-color verifies clean', async ({ page }) => {
  // CNN headline rule: color and text-decoration-color are re-set to the SAME value
  // the element already has, plus an underline. The analyzer correctly drops the
  // no-op color, but Chrome serialises the computed `text-decoration` shorthand
  // differently for an explicit colour ("underline rgb(12, 12, 12)") than for
  // currentcolor ("underline"). Verify used to compare that serialisation and
  // report a mismatch on a pixel-identical result; it now compares longhands only.
  const r = await run(
    page,
    `.h { color: rgb(12, 12, 12) }
     .l:hover .h { color: rgb(12, 12, 12); text-decoration-color: rgb(12, 12, 12); text-decoration-line: underline }`,
    '<a class="l" id="l" href="#"><span class="h" id="h">headline</span></a>',
    '#l'
  );
  expect(r.verification.diffs).toEqual([]);
});

test('CNN: lightningcss light-dark() fallback — `var(--light, X) var(--dark, Y)` — is carried as authored', async ({ page }) => {
  const r = await run(
    page,
    `:root { --lightningcss-light: initial; --lightningcss-dark: ; --c1: rgb(200, 0, 0); --c2: rgb(0, 0, 200) }
     .l .h { color: black }
     .l:hover .h { color: var(--lightningcss-light, var(--c1)) var(--lightningcss-dark, var(--c2)) }`,
    '<a class="l" id="l" href="#"><span class="h" id="h">headline</span></a>',
    '#l'
  );
  expect(r.snippet).toContain('var(--lightningcss-light');
  expect(r.verification.pass).toBe(true);
  // and the snippet's state equals a real mouse hover
  const real = await realHoverColor(page, '#h');
  const sim = await page.evaluate((code) => {
    const api = new Function('return ' + code)();
    api.applyHover();
    const c = getComputedStyle(document.getElementById('h')).color;
    api.clearHover();
    return c;
  }, r.verifySnippet);
  expect(sim).toBe(real);
});

test('Wikipedia: `a:where(:not([role=button])):hover` link rule', async ({ page }) => {
  const r = await run(
    page,
    'a { color: rgb(51, 102, 204); text-decoration: none } a:where(:not([role="button"])):hover { text-decoration: underline }',
    '<p><a id="a" href="#">link</a> <a id="b" role="button" href="#">btn</a></p>',
    '#a'
  );
  expect(r.affected.map((a) => a.props)).toEqual([['text-decoration']]);
  expect(r.verification.pass).toBe(true);
  const btn = await analyze(page, '#b');
  expect(btn.empty).toBe(true);
});

test('hover rules wrapped in @media (hover: hover) and (pointer: fine) are detected', async ({ page }) => {
  // The single most common real-world wrapper for hover styles.
  const r = await run(
    page,
    '.b { color: black } @media (hover: hover) and (pointer: fine) { .b:hover { color: rgb(255, 0, 0) } }',
    '<button class="b" id="b">b</button>',
    '#b'
  );
  expect(r.empty).toBe(false);
  expect(r.verification.pass).toBe(true);
});

test(':hover inside :is() / :where() selector lists', async ({ page }) => {
  const r = await run(
    page,
    ':is(.a:hover, .b:hover) .c { color: rgb(255, 0, 0) } :where(.a):hover .d { color: rgb(0, 128, 0) }',
    '<div class="a" id="a"><span class="c" id="c">c</span><span class="d" id="d">d</span></div>',
    '#a'
  );
  expect(r.affected.map((a) => a.el).sort()).toEqual(['span#c', 'span#d']);
  expect(r.verification.pass).toBe(true);
});

test('Apple/Wikipedia: JS-driven hover (mouseenter toggles a class) is invisible to the analyzer', async ({ page }) => {
  // Apple's globalnav flyout and Wikipedia's Page Previews both happen in JS.
  // The analyzer only sees CSS, so these report nothing -- documenting the boundary
  // so a future "dispatch mouseover/mouseenter too" feature has a failing test to flip.
  const r = await run(
    page,
    '.menu { display: none } .open .menu { display: block }',
    `<nav id="n"><a id="t" href="#">Menu</a><div class="menu">flyout</div></nav>
     <script>document.getElementById('t').addEventListener('mouseenter', () => document.getElementById('n').classList.add('open'))</script>`,
    '#t'
  );
  expect(r.empty).toBe(true);
});

test('CSS-in-JS: hover rules inserted via insertRule (no text in <style>) are read', async ({ page }) => {
  // Airbnb / GitHub-style runtime stylesheets: CSSOM-only rules, empty <style> text.
  const r = await run(
    page,
    '',
    `<button class="x1" id="b">b</button>
     <script>
       const s = document.createElement('style'); document.head.appendChild(s);
       s.sheet.insertRule('.x1 { color: black }');
       s.sheet.insertRule('.x1:hover { color: rgb(255, 0, 0) }', 1);
     </script>`,
    '#b'
  );
  expect(r.affected.map((a) => a.props)).toEqual([['color']]);
  expect(r.verification.pass).toBe(true);
});

test('hover on an <svg> icon inside a link (MDN/GitHub footer icons)', async ({ page }) => {
  const r = await run(
    page,
    'a svg { fill: gray } a:hover svg { fill: rgb(0, 0, 255) }',
    '<a id="a" href="#"><svg id="s" width="20" height="20"><rect width="20" height="20"/></svg></a>',
    'svg'
  );
  expect(r.affected.map((a) => a.el)).toEqual(['svg#s']);
  expect(r.verification.pass).toBe(true);
});

test('GitHub/Airbnb: an empty light-DOM custom element is not reported as a closed shadow root', async ({ page }) => {
  // The old check counted every hyphenated element with no element children
  // anywhere in the document. GitHub/Airbnb have such elements on every page, so
  // the panel's "may be incomplete" notice fired on 31 of 32 analyses there -- 23
  // of which were pixel-perfect. Only the hover chain matters now.
  const r = await run(
    page,
    '.b:hover { color: rgb(255, 0, 0) }',
    `<button class="b" id="b">b</button>
     <include-fragment></include-fragment>
     <relative-time>today</relative-time>`,
    '#b'
  );
  expect(r.warnings.join()).not.toMatch(/closed shadow root/);
});

const CLOSED = `<script>customElements.define('x-closed', class extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: 'closed' }).innerHTML = '<style>:host(:hover) i { color: red }</style><i>x</i>'; }
});</script>`;

test('a closed shadow root on the hover chain raises the warning', async ({ page }) => {
  // Hovering the host can restyle its closed internals (:host(:hover)), which no
  // page script can read.
  const r = await run(page, 'x-closed:hover { color: rgb(255, 0, 0) }', `<x-closed id="c"></x-closed>${CLOSED}`, '#c');
  expect(r.warnings.join()).toMatch(/closed shadow root \(x-closed#c\)/);
});

test('a closed shadow root elsewhere on the page does not', async ({ page }) => {
  // Its internals only react to the host being hovered, which is not happening here.
  const r = await run(page, '.b:hover { color: rgb(255, 0, 0) }', `<button class="b" id="b">b</button><x-closed></x-closed>${CLOSED}`, '#b');
  expect(r.warnings.join()).not.toMatch(/closed shadow root/);
});

test('Wikipedia: snippet paths anchor positional chains to the nearest ancestor id', async ({ page }) => {
  // Live picks looked like `li:nth-of-type(4) > i > b > a`; the snippet paths
  // came from the same algorithm and were just as fragile.
  const r = await run(
    page,
    'a { color: rgb(0, 0, 0) } a:hover { color: rgb(255, 0, 0) }',
    '<ul><li>x</li></ul><div id="mp"><ul><li><a>1</a></li><li><i><b><a>2</a></b></i></li></ul></div>',
    '#mp b a'
  );
  // `b > a` is unique today only because no other <b> holds a link yet
  expect(r.plan.targets.map(([p]) => p)).toEqual([['#mp b > a']]);
});

test('a strict style-src CSP does not break analysis or verify (no <style> injection while measuring)', async ({ page }) => {
  // Measuring freezes transitions and, for some rules, appends a ground-truth
  // stylesheet. Both are constructed sheets now; a <style> element would be
  // blocked by this CSP and the transition below would read as "no change".
  await serve(
    page,
    `<!doctype html><link rel="stylesheet" href="/s.css"><a class="t" id="t">t</a><script src="/lib.js"></script>`,
    {
      headers: { 'Content-Security-Policy': "style-src 'self'; script-src 'self'" },
      files: { 'http://cssh.test/s.css': { body: '.t { color: rgb(0, 0, 0); transition: color 2s } .t:hover { color: rgb(255, 0, 0) }' } },
    }
  );
  const r = await analyze(page, '#t');
  expect(r.affected.map((a) => a.props)).toEqual([['color']]);
  expect(r.verification.diffs).toEqual([]);
});

// Microsoft's nav: `text-decoration: underline var(--c); text-decoration-thickness: 2px`.
// The CSSOM serialises that rule as "text-decoration-line: ; ... thickness: 2px" --
// the var() shorthand is unreadable once a longhand is overridden. The snippet
// used to set only thickness and offset, and the underline never appeared.
const MS_RULE = ':root { --c: rgb(38, 38, 38) } .n { color: rgb(38, 38, 38); text-decoration: none } ' +
  '.n:hover { text-decoration: underline var(--c); text-decoration-thickness: 2px; text-underline-offset: 5px }';

test('Microsoft: a var() shorthand with an overridden longhand still produces the underline', async ({ page }) => {
  const r = await run(page, MS_RULE, '<a class="n" id="n" href="#">Support</a>', '#n');
  expect(r.affected[0].decls['text-decoration-line']).toEqual(['underline', '']);
  expect(r.warnings.join()).toMatch(/emitted as its resolved value/);
  expect(r.verification.diffs).toEqual([]);
});
