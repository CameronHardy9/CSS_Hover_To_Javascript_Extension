// Every case documented in fixture.html, pinned as a regression test.
// fixture.html was previously a manual page; these assert what it demonstrates.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { ROOT, analyze } from '../helpers.mjs';

test.beforeEach(async ({ page }) => {
  await page.goto('file://' + path.join(ROOT, 'fixture.html'));
  await page.waitForFunction(() => window.cssHoverToJS && document.getElementById('widget').shadowRoot);
});

const props = (r, id) => (r.affected.find((a) => a.el && a.el.endsWith('#' + id)) || {}).props;

const CASES = [
  // [name, selector, assertions(r)]
  ['1+2 descendant subject + own hover layered on ancestor', '#t', (r) => {
    expect(r.mode).toBe('inline');
    expect(r.groups.map((g) => g.host)).toEqual(['div#card-3', 'a#t']); // parent-most first
    expect(props(r, 't')).toEqual(expect.arrayContaining(['color', 'transform', 'font-weight', 'text-decoration', 'letter-spacing']));
    // authored values survive, not computed ones
    expect(r.snippet).toContain('var(--brand-600)');
    // calc() survives as calc(), but CSSOM canonicalises term order:
    // authored `calc(1px + 0.01em)` reads back as `calc(0.01em + 1px)`.
    expect(r.snippet).toMatch(/calc\((1px \+ 0\.01em|0\.01em \+ 1px)\)/);
  }],
  ['3 sibling combinators (+ and ~)', '#li1', (r) => {
    expect(props(r, 'li2')).toEqual(['background']);
    expect(r.affected.filter((a) => a.props.includes('font-style'))).toHaveLength(2);
  }],
  ['4 pseudo-element escalates to stylesheet', '#btn', (r) => {
    expect(r.mode).toBe('inline+css');
    expect(r.affected[0].pseudo).toBe(true);
    expect(r.snippet).toMatch(/::after/);
  }],
  ['5 @media: active branch only', '#t', (r) => {
    const meta = r.affected.find((a) => a.props.includes('color') && a.el === 'p');
    expect(JSON.stringify(meta.decls)).toContain('crimson');
    expect(r.snippet).not.toContain('lime');
  }],
  ['6 specificity trap: hover loses, nothing emitted', '#word', (r) => {
    expect(r.empty).toBe(true);
    expect(r.matchedButNoEffect).toBe(true);
    expect(r.snippet).toBeNull();
  }],
  ['7 base !important beats non-important hover', '#label', (r) => {
    expect(r.matchedButNoEffect).toBe(true);
  }],
  ['8 :has(:hover) styles the ancestor', '#hot', (r) => {
    expect(props(r, 'haswrap')).toEqual(['outline']);
  }],
  ['9 cascade layers: later layer wins', '#layered', (r) => {
    expect(JSON.stringify(r.affected[0].decls)).toContain('rebeccapurple');
  }],
  ['10 CSS nesting', '#nested', (r) => {
    expect(props(r, 'nested')).toEqual(['color']);
    expect(props(r, 'child')).toEqual(['font-size']);
  }],
  ['11 longhands collapse to a shorthand', '#box', (r) => {
    expect(props(r, 'box')).toEqual(['margin']);
  }],
  ['12 fan-out > 8 elements escalates to stylesheet', '#fan', (r) => {
    expect(r.mode).toBe('css');
    expect(r.affected).toHaveLength(10);
  }],
  ['13 !important on both sides', '#label2', (r) => {
    expect(r.affected[0].decls.color[1]).toBe('important');
  }],
  ['14 pre-existing style attribute is kept', '#slot', (r) => {
    // color loses to the inline style attribute; only letter-spacing changes
    expect(props(r, 'slot')).toEqual(['letter-spacing']);
  }],
  ['15 two :hover in one selector', '#kid', (r) => {
    expect(props(r, 'kid')).toEqual(['background']);
    expect(r.warnings.join()).toMatch(/more than one element hovered/);
  }],
  ['16 inverted :not(:hover) emitted as resolved value', '#inv1', (r) => {
    expect(props(r, 'inv1')).toEqual(['opacity']);
    expect(r.warnings.join()).toMatch(/removes a declaration/);
  }],
  ['17 transitions do not break verification', '#bar', (r) => {
    expect(props(r, 'bar')).toEqual(['width', 'background']);
  }],
  ['18 hover swaps a custom property consumed by descendants', '#tok', (r) => {
    expect(props(r, 'tok')).toEqual(['--local']);
  }],
  ['shadow DOM + adoptedStyleSheets', '#widget >>> .inner', (r) => {
    expect(r.mode).toBe('inline+css');
    expect(r.affected).toHaveLength(1);
  }],
];

for (const [name, sel, check] of CASES) {
  test(name, async ({ page }) => {
    const r = await analyze(page, sel);
    check(r);
    if (!r.empty) expect(r.verification.diffs).toEqual([]);
  });
}

test('analyzer leaves no residue on the page', async ({ page }) => {
  const before = await page.evaluate(() => document.documentElement.outerHTML);
  for (const [, sel] of CASES) await analyze(page, sel);
  const after = await page.evaluate(() => document.documentElement.outerHTML);
  expect(after).toBe(before);
});

test('applyOnly snippet is re-pastable (no redeclaration errors)', async ({ page }) => {
  const r = await analyze(page, '#t', { applyOnly: true });
  const errs = await page.evaluate((code) => {
    try { (0, eval)(code); (0, eval)(code); return null; } catch (e) { return e.message; }
  }, r.snippet);
  expect(errs).toBeNull();
});

test('toggle snippet: applyHover twice then clearHover restores attributes byte-for-byte', async ({ page }) => {
  const r = await analyze(page, '#slot', { verify: false });
  const out = await page.evaluate((code) => {
    const el = document.getElementById('slot');
    const before = el.getAttribute('style');
    const api = new Function('return ' + code)();
    api.applyHover(); api.applyHover(); // re-entry guard
    const during = el.getAttribute('style');
    api.clearHover(); api.clearHover();
    return { before, during, after: el.getAttribute('style') };
  }, r.verifySnippet);
  expect(out.during).not.toBe(out.before);
  expect(out.after).toBe(out.before);
});

// toggle(plan) is the eval-free runtime the extension's Apply button uses on every
// page. It must behave exactly like the toggle snippet string it mirrors.
test('toggle(plan) produces the same DOM and computed styles as the snippet, for every case', async ({ page }) => {
  for (const [name, sel] of CASES) {
    const r = await analyze(page, sel, { verify: false });
    if (r.empty) continue;
    const same = await page.evaluate(
      ([code, plan]) => {
        const els = () => {
          const out = [];
          const walk = (root) => {
            for (const el of root.querySelectorAll('*')) {
              out.push(el);
              if (el.shadowRoot) walk(el.shadowRoot);
            }
          };
          walk(document);
          return out;
        };
        const snap = () =>
          els().map((el) => {
            const cs = getComputedStyle(el);
            let s = el.outerHTML.length + '|';
            for (let i = 0; i < cs.length; i++) s += cs.getPropertyValue(cs[i]) + ';';
            return s + (el.shadowRoot ? el.shadowRoot.innerHTML : '');
          });
        const freeze = new CSSStyleSheet();
        freeze.replaceSync('*,*::before,*::after{transition:none!important;animation:none!important}');
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, freeze];
        try {
          const a = new Function('return ' + code)();
          a.applyHover();
          const viaSnippet = snap();
          a.clearHover();
          const b = window.cssHoverToJS.toggle(plan);
          b.applyHover();
          const viaPlan = snap();
          b.clearHover();
          const firstDiff = viaSnippet.findIndex((v, i) => v !== viaPlan[i]);
          return firstDiff < 0 && viaSnippet.length === viaPlan.length ? true : `element #${firstDiff} differs`;
        } finally {
          document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== freeze);
        }
      },
      [r.verifySnippet, r.plan]
    );
    expect(same, name).toBe(true);
  }
});

test('verify checks the snippet string itself when eval is allowed', async ({ page }) => {
  const r = await analyze(page, '#t');
  expect(r.verification.checked).toBe('snippet');
});
