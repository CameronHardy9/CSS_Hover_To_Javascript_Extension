// Loads the unpacked extension into Chromium and opens its real side panel UI
// as a tab, so tests drive exactly what a user clicks.
//
// The panel binds to `chrome.tabs.query({ active: true, currentWindow: true })`,
// and re-binds on tabs.onActivated -- so opening the panel tab first and then
// bringing the target page to the front attaches it to that page.
import { test as base, chromium, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LIBRARY, ORIGIN } from '../helpers.mjs';
import { stage } from '../../scripts/runtime-files.mjs';

export const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    // Only the runtime files, never the repo root -- the same set as the release zip.
    const ext = stage(fs.mkdtempSync(path.join(os.tmpdir(), 'cssh-ext-')));
    const ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium', // the headless build that supports extensions
      headless: true,
      viewport: { width: 1280, height: 800 },
      args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
    });
    await use(ctx);
    await ctx.close();
    fs.rmSync(ext, { recursive: true, force: true });
  },

  extensionId: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    await use(sw.url().split('/')[2]);
  },

  /**
   * site.serve(html, {headers, files}) -> page on http://cssh.test/ with the panel
   * attached. Returns { page, panel }.
   */
  site: async ({ context, extensionId }, use) => {
    await use({
      async open(html, { headers = {}, files = {}, path: p = '/' } = {}) {
        await context.route('**/*', (route) => {
          const url = route.request().url();
          if (url.startsWith(`${ORIGIN}/`) && !files[url] && !url.endsWith('/lib.js')) {
            return route.fulfill({ status: 200, contentType: 'text/html', headers, body: html });
          }
          if (url.endsWith('/lib.js')) return route.fulfill({ contentType: 'text/javascript', body: LIBRARY });
          if (files[url]) {
            // Requests from the extension's service worker carry no page frame.
            // (Playwright throws from frame() for service-worker requests.)
            const fromWorker = (() => { try { return !route.request().frame(); } catch { return true; } })();
            if (files[url].failExtensionFetch && fromWorker) return route.fulfill({ status: 403, body: '' });
            return route.fulfill({ status: 200, contentType: files[url].type || 'text/css', body: files[url].body });
          }
          return route.continue();
        });
        const page = context.pages()[0] || (await context.newPage());
        await page.goto(`${ORIGIN}${p}`);
        const panel = await context.newPage();
        await panel.goto(`chrome-extension://${extensionId}/extension/sidepanel.html`);
        await page.bringToFront(); // fires tabs.onActivated -> panel attaches to page
        await expect(panel.locator('#page-url')).toHaveText(/cssh\.test/);
        return { page, panel };
      },
    });
  },
});

export { expect };

/** Pick `locator` through the panel's real picker. */
export async function pickWithPanel(panel, page, locator) {
  await panel.locator('#pick').click();
  await expect(panel.locator('#pick')).toHaveText('Cancel pick');
  await page.bringToFront();
  const b = await locator.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await expect(panel.locator('#pick')).toHaveText('Pick element');
  // Picking is a real hover: let the page's own transitions run back out before
  // anything takes a baseline.
  await page.mouse.move(-10, -10);
  await page.waitForTimeout(SETTLE);
  return panel.locator('#selector').inputValue();
}

/** Screenshot of a clip with the mouse really hovering `locator`. */
export const SETTLE = 500; // longer than any transition in the test pages

export async function realHoverShot(page, locator, clip) {
  const b = await locator.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.waitForTimeout(SETTLE);
  const shot = await page.screenshot({ clip });
  await page.mouse.move(-10, -10);
  await page.waitForTimeout(SETTLE);
  return shot;
}
