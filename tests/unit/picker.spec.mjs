// extension/picker.js, driven with a real mouse. chrome.runtime is stubbed so the
// content script can run in an ordinary page; messages it sends are recorded.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { ROOT, serve, doc } from '../helpers.mjs';

const PICKER = path.join(ROOT, 'extension', 'picker.js');

const STUB = () => {
  window.__msgs = [];
  window.__listeners = [];
  window.chrome = {
    runtime: {
      sendMessage: (m) => { window.__msgs.push(m); return Promise.resolve(); },
      onMessage: {
        addListener: (fn) => window.__listeners.push(fn),
        removeListener: (fn) => { window.__listeners = window.__listeners.filter((f) => f !== fn); },
      },
    },
  };
};

const BODY = `
  <nav id="nav"><ul>
    <li><a href="#">one</a></li><li><a href="#">two</a></li><li><a href="#" class="x">three</a></li>
  </ul></nav>
  <button data-testid="save" class="btn">Save</button>
  <button class="btn">Plain</button><button class="btn">Plain</button>
  <div id="1bad"><span class="cssh-on">marker</span><span>other</span></div>
  <div id="a:b" class="card"><p>weird id</p></div>
  <x-w id="w"></x-w>
  <script>
    customElements.define('x-w', class extends HTMLElement { connectedCallback() {
      this.attachShadow({ mode: 'open' }).innerHTML = '<div class="wrap"><span class="inner">in</span><span class="inner">in2</span></div>';
    }});
    window.__pageClicks = 0;
    document.addEventListener('click', () => window.__pageClicks++);
  </script>`;

test.beforeEach(async ({ page }) => {
  await serve(page, doc('button,a,span,p{display:inline-block;padding:6px;margin:4px}', BODY));
  await page.evaluate(STUB);
});

const startPicker = (page) => page.addScriptTag({ path: PICKER });

async function pick(page, locator) {
  await startPicker(page);
  const box = await locator.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const msgs = await page.evaluate(() => window.__msgs);
  return msgs.find((m) => m.type === 'picked');
}

/** Resolve a `a >>> b` selector the way inject.js does. */
const resolveIs = (page, selector, locator) =>
  locator.evaluate((target, sel) => {
    let n = document;
    for (const s of sel.split('>>>').map((x) => x.trim())) n = (n.shadowRoot || n).querySelector(s);
    return n === target;
  }, selector);

const CASES = [
  ['an attribute-addressed element', (p) => p.getByTestId('save'), 'button[data-testid="save"]'],
  ['an ambiguous sibling via nth-of-type', (p) => p.locator('button.btn').nth(2), /:nth-of-type\(3\)$/],
  ['a nav link under an id', (p) => p.locator('#nav a').nth(1), null],
  ['an element inside an open shadow root', (p) => p.locator('x-w .inner').nth(1), /^#w >>> /],
  ['a child of an id that is not a valid identifier', (p) => p.locator('[id="1bad"] span').nth(1), null],
  ['a child of an id containing a colon', (p) => p.locator('[id="a:b"] p'), null],
];

for (const [name, loc, expected] of CASES) {
  test(`picks ${name} with a unique selector that resolves back to it`, async ({ page }) => {
    const target = loc(page);
    const m = await pick(page, target);
    expect(m, 'picker sent a picked message').toBeTruthy();
    if (expected instanceof RegExp) expect(m.selector).toMatch(expected);
    else if (expected) expect(m.selector).toBe(expected);
    expect(await resolveIs(page, m.selector, target)).toBe(true);
  });
}

test('ignores the snippet marker class when building selectors', async ({ page }) => {
  const m = await pick(page, page.locator('[id="1bad"] span').first());
  expect(m.selector).not.toContain('cssh-on');
  expect(m.desc).not.toContain('cssh-on');
});

test('swallows the click so the page never sees it, and tears down', async ({ page }) => {
  await pick(page, page.locator('#nav a').first());
  expect(await page.evaluate(() => window.__pageClicks)).toBe(0);
  expect(await page.locator('#__cssh-picker').count()).toBe(0);
  expect(await page.evaluate(() => window.__csshPicker)).toBeUndefined();
  // the crosshair cursor rule is gone too
  expect(await page.evaluate(() => [...document.querySelectorAll('style')].some((s) => s.textContent.includes('crosshair')))).toBe(false);
});

test('Esc cancels and reports pickerCancelled', async ({ page }) => {
  await startPicker(page);
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.__msgs)).toEqual([{ type: 'pickerCancelled' }]);
  expect(await page.locator('#__cssh-picker').count()).toBe(0);
});

test('stop message from the background tears the picker down', async ({ page }) => {
  await startPicker(page);
  await page.evaluate(() => window.__listeners.forEach((fn) => fn({ type: 'cssh-stop-picker' })));
  expect(await page.locator('#__cssh-picker').count()).toBe(0);
});

test('injecting twice does not stack two pickers', async ({ page }) => {
  await startPicker(page);
  await startPicker(page);
  expect(await page.locator('#__cssh-picker').count()).toBe(1);
});

test('never writes to any element style attribute while picking', async ({ page }) => {
  const before = await page.evaluate(() => [...document.querySelectorAll('[style]')].length);
  await startPicker(page);
  for (const l of [page.locator('#nav a').first(), page.getByTestId('save')]) {
    const b = await l.boundingBox();
    await page.mouse.move(b.x + 2, b.y + 2);
  }
  const during = await page.evaluate(() => [...document.querySelectorAll('body [style]')].length);
  expect(during).toBe(before);
});

// Found on live sites: the picker used to stop at the first selector that was unique
// *right now*, so a link two levels under #nav came back as `li:nth-of-type(2) > a`
// -- anchored to nothing. Wikipedia picks looked like `li:nth-of-type(4) > i > b > a`.
test('anchors a positional chain to the nearest ancestor id', async ({ page }) => {
  const m = await pick(page, page.locator('#nav a').nth(1));
  expect(m.selector).toBe('#nav li:nth-of-type(2) > a');
});

test('a picked selector still matches only its target after content is added elsewhere', async ({ page }) => {
  const target = page.locator('#nav a').nth(1);
  const m = await pick(page, target);
  // simulate a late-loading list ABOVE the nav (lazy load, ad slot)
  await page.evaluate(() => document.body.insertAdjacentHTML('afterbegin', '<ul><li>a</li><li><a>ad</a></li></ul>'));
  expect(await page.evaluate((sel) => document.querySelectorAll(sel).length, m.selector)).toBe(1);
  expect(await resolveIs(page, m.selector, target)).toBe(true);
});

test('a unique class selector is kept as is, not anchored', async ({ page }) => {
  const m = await pick(page, page.locator('#nav a.x'));
  expect(m.selector).toBe('a.x');
});

// Found on GitHub: JS added `.open` to a container on hover; the picker, which
// builds the selector at click time -- i.e. while hovered -- baked it in as
// `div.Container__Jc-wO9.open > button`. Once the mouse left, the class was gone
// and analysis failed with "Selector matched nothing on this page."
test('a class added by JS during hover does not end up in the picked selector', async ({ page }) => {
  await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<div class="menu" id="m"><button class="go">Go</button></div><div class="menu"><button class="go">Go</button></div>');
    const m = document.getElementById('m');
    m.addEventListener('mouseenter', () => m.classList.add('open'));
    m.addEventListener('mouseleave', () => m.classList.remove('open'));
    m.removeAttribute('id'); // force a class-based path
  });
  const m = await pick(page, page.locator('.menu button').first());
  expect(m.selector).not.toContain('.open');
  await page.mouse.move(-10, -10);
  expect(await page.evaluate((sel) => document.querySelectorAll(sel).length, m.selector)).toBe(1);
});
