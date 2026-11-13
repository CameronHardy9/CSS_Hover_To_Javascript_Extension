import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LIBRARY = fs.readFileSync(path.join(ROOT, 'cssHoverToJavascript.js'), 'utf8');
export const ORIGIN = 'http://cssh.test';
export const OTHER_ORIGIN = 'http://cdn.other.test';

/**
 * Serve `html` at http://cssh.test/ with optional response headers (e.g. a CSP),
 * plus any extra files keyed by absolute URL. Requests are fulfilled in-process,
 * so no server is needed and cross-origin setups are just a second hostname.
 *
 * The library is served at /lib.js so tests can include it with a <script src>,
 * which works under a strict CSP where addScriptTag's inline script would not.
 */
export async function serve(page, html, { headers = {}, files = {} } = {}) {
  page.__files = files;
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url === `${ORIGIN}/` || url === `${ORIGIN}/index.html`) {
      return route.fulfill({ status: 200, contentType: 'text/html', headers, body: html });
    }
    if (url === `${ORIGIN}/lib.js`) {
      return route.fulfill({ status: 200, contentType: 'text/javascript', body: LIBRARY });
    }
    if (files[url]) {
      const f = files[url];
      return route.fulfill({ status: 200, contentType: f.type || 'text/css', body: f.body, headers: f.headers || {} });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto(`${ORIGIN}/`);
}

/** Wrap CSS + body markup in a page that loads the library. */
export const doc = (css, body, { head = '' } = {}) => `<!doctype html><html><head><meta charset="utf-8">
<style>${css}</style>${head}</head><body>${body}<script src="/lib.js"></script></body></html>`;

/**
 * Run cssHoverToJS against `selector` and return a cloneable projection.
 * Uses verify:true by default -- every case should prove itself.
 */
export function analyze(page, selector, opts = {}) {
  return page.evaluate(
    ([sel, o]) => {
      const segs = sel.split('>>>').map((s) => s.trim());
      let el = document;
      for (const s of segs) el = (el.shadowRoot || el).querySelector(s);
      const r = window.cssHoverToJS(el, { verify: true, log: false, ...o });
      const d = (e) => (e ? e.localName + (e.id ? '#' + e.id : '') : null);
      return {
        mode: r.mode,
        empty: !r.groups.length,
        matchedButNoEffect: !!r.matchedButNoEffect,
        hoverRoot: d(r.hoverRoot),
        groups: r.groups.map((g) => ({ host: d(g.host), elements: g.elements.length, touchesTarget: g.touchesTarget })),
        affected: r.affected.map((a) => ({ el: d(a.el), props: Object.keys(a.decls), decls: a.decls, pseudo: a.pseudoHits.length > 0 })),
        warnings: r.warnings,
        snippet: r.snippet,
        verifySnippet: r._internals && r._internals.verifySnippet,
        plan: r.plan || null,
        verification: r.verification && {
          pass: r.verification.pass,
          checked: r.verification.checked,
          diffs: r.verification.diffs.map((x) => ({ el: d(x.el), prop: x.prop, expected: x.expected, got: x.got, kind: x.kind })),
        },
      };
    },
    [selector, opts]
  );
}

let seq = 0;
/**
 * Run `fn(...args)` as a real page script (a <script src> from the page's own
 * origin), so the page CSP applies to it. page.evaluate() goes through the
 * DevTools protocol and is exempt from the eval CSP, exactly like the console --
 * which hides CSP behaviour the extension's executeScript calls DO hit.
 * Only usable on pages served with serve().
 */
export async function inPage(page, fn, ...args) {
  const url = `${ORIGIN}/__run${++seq}.js`;
  page.__files[url] = {
    type: 'text/javascript',
    body: `window.__inPage = (${fn})(...${JSON.stringify(args)});`,
  };
  await page.addScriptTag({ url });
  return page.evaluate(() => window.__inPage);
}
