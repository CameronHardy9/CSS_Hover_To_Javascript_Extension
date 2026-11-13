// End-to-end through the real extension: service worker, injection, picker and
// side panel UI. Each test reproduces a situation hit in the live-site sweep.
import { test, expect, pickWithPanel, realHoverShot, SETTLE } from './fixtures.mjs';
import { OTHER_ORIGIN } from '../helpers.mjs';

const CARD = `<!doctype html><meta charset="utf-8">
<style>
  body { font: 16px/1.4 sans-serif; margin: 40px }
  .card { display: inline-block; padding: 16px; background: #f4f4f4; transition: background .2s }
  .card .title { color: #333 }
  .card:hover { background: rgb(220, 230, 255) }
  .card:hover .title { color: rgb(200, 0, 0); text-decoration: underline }
  .card .btn::after { content: ' ›'; opacity: .2 }
  .card:hover .btn::after { opacity: 1 }
</style>
<div class="card" id="card"><a class="title" id="t" href="#">Card title</a> <span class="btn">go</span></div>
<p id="other">unrelated</p>`;

const CLIP = { x: 0, y: 0, width: 400, height: 140 };

test('pick → analyze → apply matches a real mouse hover pixel-for-pixel → clear restores', async ({ site }) => {
  const { page, panel } = await site.open(CARD);
  await expect(panel.locator('#world')).toHaveText('ready');

  const selector = await pickWithPanel(panel, page, page.locator('#t'));
  expect(selector).toBe('#t');
  await expect(panel.locator('#match')).toHaveText(/^Matches a#t/);

  const domBefore = await page.evaluate(() => document.body.innerHTML);
  const baseShot = await page.screenshot({ clip: CLIP });
  const realShot = await realHoverShot(page, page.locator('#t'), CLIP);
  expect(realShot.equals(baseShot)).toBe(false); // the hover is visible

  await panel.locator('#analyze').click();
  await expect(panel.locator('.snippet')).toBeVisible();
  await expect(panel.locator('.note.fail')).toHaveCount(0); // verify passed silently
  await expect(panel.locator('.summary')).toContainText('inline+css'); // ::after escalates

  await panel.locator('#hover-toggle').click();
  await expect(panel.locator('#hover-toggle')).toHaveText('Clear hover');
  await page.waitForTimeout(SETTLE); // let the page's own transition finish
  const simShot = await page.screenshot({ clip: CLIP });
  expect(simShot.equals(realShot), 'snippet state should be pixel-identical to a real hover').toBe(true);

  await panel.locator('#hover-toggle').click();
  await expect(panel.locator('#hover-toggle')).toHaveText('Apply hover');
  await page.waitForTimeout(SETTLE);
  expect(await page.evaluate(() => document.body.innerHTML)).toBe(domBefore);
  expect((await page.screenshot({ clip: CLIP })).equals(baseShot)).toBe(true);
});

test('the snippet the user copies reproduces the hover when pasted into the page', async ({ site }) => {
  const { page, panel } = await site.open(CARD);
  await panel.locator('#selector').fill('#t');
  await expect(panel.locator('#analyze')).toBeEnabled();
  await panel.locator('#analyze').click();
  const snippet = await panel.locator('.snippet').textContent();
  const realShot = await realHoverShot(page, page.locator('#t'), CLIP);
  await page.evaluate(snippet); // what a visual test would do
  await page.waitForTimeout(SETTLE);
  expect((await page.screenshot({ clip: CLIP })).equals(realShot)).toBe(true);
});

test('re-analyzing while a hover is applied reads the clean base state', async ({ site }) => {
  const { panel } = await site.open(CARD);
  await panel.locator('#selector').fill('#t');
  await expect(panel.locator('#analyze')).toBeEnabled();
  await panel.locator('#analyze').click();
  const first = await panel.locator('.snippet').textContent();
  await panel.locator('#hover-toggle').click();
  await panel.locator('#analyze').click();
  await expect(panel.locator('#hover-toggle')).toHaveText('Apply hover');
  expect(await panel.locator('.snippet').textContent()).toBe(first);
});

test('GitHub/MDN: page CSP without unsafe-eval — Apply still matches a real hover, Clear restores', async ({ site }) => {
  // Both GitHub and MDN ship this CSP. The hover button used to be disabled there;
  // it now runs the result's plan through the library's eval-free toggle().
  const { page, panel } = await site.open(CARD, {
    headers: { 'Content-Security-Policy': "script-src 'self'; object-src 'none'" },
  });
  await expect(panel.locator('#world')).toHaveText('ready');
  await panel.locator('#selector').fill('#t');
  await expect(panel.locator('#analyze')).toBeEnabled();
  const baseShot = await page.screenshot({ clip: CLIP });
  const realShot = await realHoverShot(page, page.locator('#t'), CLIP);
  await panel.locator('#analyze').click();
  await expect(panel.locator('.snippet')).toBeVisible();
  await expect(panel.locator('.note.fail')).toHaveCount(0); // verified (via the plan), and passed
  await expect(panel.locator('#hover-toggle')).toBeEnabled();
  await panel.locator('#hover-toggle').click();
  await expect(panel.locator('#hover-toggle')).toHaveText('Clear hover');
  await page.waitForTimeout(SETTLE);
  expect((await page.screenshot({ clip: CLIP })).equals(realShot)).toBe(true);
  await panel.locator('#hover-toggle').click();
  await page.waitForTimeout(SETTLE);
  expect((await page.screenshot({ clip: CLIP })).equals(baseShot)).toBe(true);
});

test('Microsoft/CNN: a cross-origin stylesheet is fetched by the extension and analysed', async ({ site }) => {
  const html = CARD.replace('</style>', `</style><link rel="stylesheet" href="${OTHER_ORIGIN}/brand.css">`);
  const { page, panel } = await site.open(html, {
    files: { [`${OTHER_ORIGIN}/brand.css`]: { body: '#other:hover { color: rgb(0, 128, 0); text-decoration: underline }' } },
  });
  // the page itself really cannot read it
  expect(await page.evaluate(() => { try { return [...document.styleSheets].every((s) => s.cssRules); } catch { return false; } })).toBe(false);
  await panel.locator('#selector').fill('#other');
  await expect(panel.locator('#analyze')).toBeEnabled();
  await panel.locator('#analyze').click();
  await expect(panel.locator('.snippet')).toBeVisible();
  await expect(panel.locator('#results')).not.toContainText('may be incomplete');
  await expect(panel.locator('.note.fail')).toHaveCount(0);
  const clip = { x: 0, y: 100, width: 400, height: 80 };
  const realShot = await realHoverShot(page, page.locator('#other'), clip);
  await panel.locator('#hover-toggle').click();
  await page.waitForTimeout(SETTLE);
  expect((await page.screenshot({ clip })).equals(realShot)).toBe(true);
});

test('a cross-origin stylesheet that cannot be fetched still raises the "may be incomplete" notice', async ({ site }) => {
  const html = CARD.replace('</style>', `</style><link rel="stylesheet" href="${OTHER_ORIGIN}/brand.css">`);
  // served to the page as CSS, but answers the extension's cookie-less fetch with an error
  const { page, panel } = await site.open(html, {
    files: { [`${OTHER_ORIGIN}/brand.css`]: { body: '#other:hover{color:rgb(255, 0, 0)}', failExtensionFetch: true } },
  });
  // the page itself did get the sheet: a real hover turns the text red
  await page.locator('#other').hover();
  await expect(page.locator('#other')).toHaveCSS('color', 'rgb(255, 0, 0)');
  await page.mouse.move(-10, -10);
  await panel.locator('#selector').fill('#other');
  await expect(panel.locator('#analyze')).toBeEnabled();
  await panel.locator('#analyze').click();
  // The real page DOES change on hover; the panel must not imply "nothing to do".
  await expect(panel.locator('#results')).toContainText('No hover styling is reachable');
  await expect(panel.locator('#results')).toContainText('This snippet may be incomplete');
  await expect(panel.locator('#results')).toContainText(`${OTHER_ORIGIN}/brand.css`);
});

const CLOSED_DEF = `<script>customElements.define('x-closed', class extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: 'closed' }).innerHTML = '<style>:host(:hover) b { color: red }</style><b>in</b> <slot></slot>'; }
});</script>`;

test('a closed shadow root on the hover chain is detected via chrome.dom (even with light children)', async ({ site }) => {
  // The host has a light child, so the library's own page-script guess cannot see it.
  const { panel } = await site.open(`<!doctype html><style>.l:hover { color: rgb(0, 0, 255) }</style>
    <x-closed id="c"><a class="l" id="l" href="#">slotted</a></x-closed>${CLOSED_DEF}`);
  await panel.locator('#selector').fill('#l');
  await expect(panel.locator('#analyze')).toBeEnabled();
  await panel.locator('#analyze').click();
  await expect(panel.locator('#results')).toContainText('This snippet may be incomplete');
  await expect(panel.locator('#results')).toContainText('x-closed#c');
});

test('GitHub/Airbnb: empty custom elements and off-chain closed roots raise no notice', async ({ site }) => {
  const { panel } = await site.open(`<!doctype html><style>.l:hover { color: rgb(0, 0, 255) }</style>
    <include-fragment></include-fragment><relative-time></relative-time><x-closed></x-closed>
    <a class="l" id="l" href="#">link</a>${CLOSED_DEF}`);
  await panel.locator('#selector').fill('#l');
  await expect(panel.locator('#analyze')).toBeEnabled();
  await panel.locator('#analyze').click();
  await expect(panel.locator('.snippet')).toBeVisible();
  await expect(panel.locator('#results')).not.toContainText('may be incomplete');
});

test('a selector matching several elements says the first will be analyzed', async ({ site }) => {
  const { panel } = await site.open(CARD + '<div class="card"><a class="title">2</a></div>');
  await panel.locator('#selector').fill('.title');
  await expect(panel.locator('#match')).toHaveText(/Matches 2 elements — the first \(a#t\.title\)/);
});

test('reload keeps the selector; the applied state and results are dropped', async ({ site }) => {
  const { page, panel } = await site.open(CARD);
  await panel.locator('#selector').fill('#t');
  await expect(panel.locator('#analyze')).toBeEnabled();
  await panel.locator('#analyze').click();
  await panel.locator('#hover-toggle').click();
  await page.reload();
  await expect(panel.locator('#selector')).toHaveValue('#t');
  await expect(panel.locator('#results')).toBeEmpty();
  await expect(panel.locator('#live')).toBeHidden();
  // library was re-injected into the fresh document
  await expect(panel.locator('#world')).toHaveText('ready');
});

test('JS-driven hover (Apple globalnav / Wikipedia previews) is reported as no CSS hover', async ({ site }) => {
  const { panel } = await site.open(`<!doctype html><style>.m{display:none}.open .m{display:block}</style>
    <nav id="n"><a id="t" href="#">Menu</a><div class="m">flyout</div></nav>
    <script>t.addEventListener('mouseenter',()=>n.classList.add('open'))</script>`);
  await panel.locator('#selector').fill('#t');
  await expect(panel.locator('#analyze')).toBeEnabled();
  await panel.locator('#analyze').click();
  await expect(panel.locator('#results')).toContainText('No hover styling is reachable');
});

test('restricted pages show the restricted banner', async ({ context, extensionId }) => {
  const page = context.pages()[0] || (await context.newPage());
  await page.goto('chrome://version');
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/extension/sidepanel.html`);
  await page.bringToFront();
  await expect(panel.locator('#banner')).toContainText('does not allow extensions');
});
