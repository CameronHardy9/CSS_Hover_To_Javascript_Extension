/**
 * Service worker: owns all injection and relays between the side panel and the page.
 *
 * The panel never touches chrome.scripting itself -- it sends a message and gets a
 * plain object back.
 *
 * Everything runs in the page's MAIN world, so `window.cssHoverToJS` is also
 * reachable from the page's own DevTools console, preserving the workflow the
 * README documents. There is deliberately no isolated-world fallback: measured on
 * Chrome 151, `new Function` is blocked in BOTH worlds on a page whose CSP omits
 * 'unsafe-eval' -- by the page CSP in MAIN, and by the extension's own MV3 CSP in
 * ISOLATED, which cannot be relaxed. Switching worlds buys nothing, so instead the
 * panel asks up front whether eval works here (`getCapabilities`) and disables the
 * two features that need it. Analysis and snippet generation need no eval and work
 * on every page.
 */
import { getCapabilities, runAnalysis, applySnippet, clearSnippet, probeSelector, flashSelector } from './inject.js';

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
      return call(tabId, runAnalysis, [msg.selector]);
    case 'apply':
      return call(tabId, applySnippet, [msg.code]);
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
