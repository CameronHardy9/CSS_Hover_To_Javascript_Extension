/**
 * Service worker: owns all injection and relays between the side panel and the page.
 *
 * The panel never touches chrome.scripting itself -- it sends a message and gets a
 * plain object back.
 *
 * The library runs in the page's MAIN world, so `window.cssHoverToJS` is also
 * reachable from the page's own DevTools console, preserving the workflow the
 * README documents. Nothing here evals: the hover button sends the result's
 * `plan` (plain data) to the library's toggle(), so a page CSP without
 * 'unsafe-eval' -- GitHub, MDN -- limits nothing.
 *
 * Two things page script cannot do are done here on its behalf before analysis:
 *  - read cross-origin stylesheets: fetched with the extension's host permission
 *    and handed to the library as text;
 *  - tell a closed shadow root from an ordinary element: chrome.dom, which only
 *    exists in the extension's ISOLATED world.
 */
import {
  getCapabilities, runAnalysis, applySnippet, clearSnippet, probeSelector, flashSelector,
  unreadableSheets, provideSheets, closedShadowHosts,
} from './inject.js';

const LIBRARY = 'cssHoverToJavascript.js'; // at the extension root, injected verbatim
const PICKER = 'extension/picker.js';
const WORLD = 'MAIN';

/* ---------------------------- page invocation ---------------------------- */

async function exec(tabId, func, args) {
  const [hit] = await chrome.scripting.executeScript({ target: { tabId }, world: WORLD, func, args });
  return hit ? hit.result : undefined;
}

/**
 * Inject the library if it is not already present.
 *
 * Injecting by `files` rather than as a code string means page CSP never blocks
 * the injection itself, even on pages that forbid inline script.
 */
async function ensureLibrary(tabId, force = false) {
  if (!force) {
    const caps = await exec(tabId, getCapabilities, []);
    if (caps && caps.version) return caps;
  }
  await chrome.scripting.executeScript({ target: { tabId }, world: WORLD, files: [LIBRARY] });
  return exec(tabId, getCapabilities, []);
}

/** Run a function that needs the library present. */
async function call(tabId, func, args) {
  await ensureLibrary(tabId);
  let result = await exec(tabId, func, args);
  if (result && result.notInjected) {
    // Injection reported success but the global is gone -- a navigation raced us.
    await ensureLibrary(tabId, true);
    result = await exec(tabId, func, args);
  }
  return result;
}

/* --------------------------- cross-origin stylesheets --------------------------- */

// href -> Promise<cssText | null>, for the life of the service worker.
const sheetCache = new Map();
const SHEET_CACHE_MAX = 200;
const SHEET_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Fetch a stylesheet the page cannot read. Cookies are never sent, and the
 * response must be served as CSS -- the browser only applied the original
 * because it was, and this keeps the extension from being turned into a way to
 * read arbitrary cross-origin text into the page.
 */
function fetchSheet(href) {
  if (!/^https?:/i.test(href)) return Promise.resolve(null);
  if (!sheetCache.has(href)) {
    if (sheetCache.size >= SHEET_CACHE_MAX) sheetCache.delete(sheetCache.keys().next().value);
    sheetCache.set(
      href,
      (async () => {
        try {
          const r = await fetch(href, { credentials: 'omit', cache: 'force-cache' });
          if (!r.ok || !/\btext\/css\b/i.test(r.headers.get('content-type') || '')) return null;
          const text = await r.text();
          return text.length > SHEET_MAX_BYTES ? null : text;
        } catch {
          return null;
        }
      })().then((t) => {
        if (t === null) sheetCache.delete(href); // retry next time instead of caching a failure
        return t;
      })
    );
  }
  return sheetCache.get(href);
}

/** Give the library every stylesheet it cannot read itself. Best effort. */
async function supplySheets(tabId) {
  const hrefs = (await exec(tabId, unreadableSheets, [])) || [];
  if (!hrefs.length) return;
  const texts = await Promise.all(hrefs.map(fetchSheet));
  const map = {};
  hrefs.forEach((h, i) => { if (texts[i] !== null) map[h] = texts[i]; });
  if (Object.keys(map).length) await exec(tabId, provideSheets, [map]);
}

async function analyze(tabId, selector) {
  await ensureLibrary(tabId);
  await supplySheets(tabId).catch(() => {});
  const [hit] = await chrome.scripting
    .executeScript({ target: { tabId }, world: 'ISOLATED', func: closedShadowHosts, args: [selector] })
    .catch(() => []);
  const closed = hit && Array.isArray(hit.result) ? hit.result : undefined;
  return call(tabId, runAnalysis, [selector, { closedShadowHosts: closed }]);
}

/* ------------------------------ message router ------------------------------ */

async function handle(msg) {
  // The picker content script broadcasts these; chrome.runtime.sendMessage already
  // delivers them to the panel directly, so there is nothing to forward here --
  // this branch only exists so they do not fall through to the tabId check.
  if (msg.type === 'picked' || msg.type === 'pickerCancelled') return { ok: true };

  const tabId = msg.tabId;
  if (typeof tabId !== 'number') return { ok: false, error: 'No page to talk to.' };

  switch (msg.type) {
    case 'status':
      return { ok: true, ...(await ensureLibrary(tabId)) };
    case 'reinject':
      return { ok: true, ...(await ensureLibrary(tabId, true)) };
    case 'analyze':
      return analyze(tabId, msg.selector);
    case 'apply':
      return call(tabId, applySnippet, [msg.plan]);
    case 'clear':
      return call(tabId, clearSnippet, []);
    // Neither of these needs the library, so they skip the injection check.
    case 'probe':
      return exec(tabId, probeSelector, [msg.selector]);
    case 'flash':
      return exec(tabId, flashSelector, [msg.selector, msg.ms || 1200]);
    case 'startPicker':
      await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', files: [PICKER] });
      return { ok: true };
    case 'stopPicker':
      await chrome.tabs.sendMessage(tabId, { type: 'cssh-stop-picker' }).catch(() => {});
      return { ok: true };
    default:
      return { ok: false, error: `Unknown message: ${msg.type}` };
  }
}

/** Fire-and-forget to the side panel; rejects when the panel is closed. */
const toPanel = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  handle(msg).then(respond, (e) => {
    const text = e && e.message ? e.message : String(e);
    respond({
      ok: false,
      error: text,
      // chrome://, the Web Store and other privileged origins refuse injection.
      restricted: /cannot be scripted|Cannot access contents|chrome:\/\/|extension:\/\//i.test(text),
    });
  });
  return true; // keep the channel open for the async respond
});

/* -------------------------------- tab events -------------------------------- */

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// A navigation wipes the injected library and invalidates any generated selector.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;
  toPanel({ type: 'tabChanged', tabId, url: changeInfo.url || null, reason: 'navigation' });
});

chrome.tabs.onActivated.addListener(({ tabId }) => toPanel({ type: 'tabChanged', tabId, reason: 'activated' }));
