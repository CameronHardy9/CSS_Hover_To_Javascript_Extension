/**
 * Functions executed inside the inspected page via chrome.scripting.executeScript.
 *
 * HARD CONSTRAINT: executeScript serialises each function with toString(), so a
 * function here may not reference ANYTHING outside its own body -- no imports, no
 * module-scope constants, no sibling helpers. Every helper is duplicated inline.
 * That is why this file repeats `resolve` and `desc` several times.
 *
 * Everything returns a plain, structured-cloneable object. The library's own
 * return value is not cloneable -- `target`, `hoverRoot`, `groups[].host`,
 * `affected[].el` and all of `_internals` are live DOM nodes and CSSRules -- so it
 * is projected to JSON inside the page, never sent across the boundary as-is.
 */

/**
 * Report whether the library is present and whether this page can run generated
 * code at all.
 *
 * `verify: true` and the Apply / Clear buttons both need `new Function`, which a
 * page whose CSP omits 'unsafe-eval' forbids. Probing once, up front, lets the
 * panel disable exactly those two features and say why, rather than letting the
 * user click and get an exception. Analysis and snippet generation need no eval.
 */
export function getCapabilities() {
  let evalOk = false;
  try {
    evalOk = new Function('return 1')() === 1;
  } catch { /* page CSP forbids 'unsafe-eval' */ }
  return { version: (window.cssHoverToJS && window.cssHoverToJS.version) || null, evalOk };
}

/**
 * Run the analyzer and flatten the result.
 *
 * `selector` is one string. Shadow boundaries are written `host >>> inner`, one
 * segment per boundary, resolved the same way the generated snippets resolve
 * their path arrays: `(node.shadowRoot || node).querySelector(seg)`.
 *
 * The library options are not the caller's to choose, and neither is the console
 * report -- the extension is opinionated where the library is general.
 */
export function runAnalysis(selector) {
  // The two warnings that mean the analyzer could not SEE some CSS, as opposed to
  // the ones describing how it chose to write the snippet. Always-on verify does
  // not catch these: unreadable rules cannot be rewritten for the ground-truth
  // snapshot either, so both sides of the comparison are blind in the same way and
  // it passes on an answer that is wrong. They are the one thing the UI surfaces.
  const UNREADABLE = /Cross-origin stylesheet is unreadable|closed shadow root cannot be read/;

  const resolve = (sel) => {
    const segs = sel.split('>>>').map((s) => s.trim()).filter(Boolean);
    if (!segs.length) return null;
    let node = document;
    for (const seg of segs) {
      node = (node.shadowRoot || node).querySelector(seg);
      if (!node) return null;
    }
    return node;
  };
  const desc = (el) =>
    !el
      ? null
      : el === document.documentElement
        ? 'html'
        : el.localName +
          (el.id ? '#' + el.id : '') +
          // Skip the snippet's own marker class -- that is our residue, not the
          // page's, and it only appears while a hover is applied.
          [...el.classList].filter((c) => c !== 'cssh-on').slice(0, 2).map((c) => '.' + c).join('');

  if (!window.cssHoverToJS) return { ok: false, notInjected: true, error: 'cssHoverToJS is not present on this page.' };

  let el;
  try {
    el = resolve(selector);
  } catch (e) {
    return { ok: false, error: 'Invalid selector: ' + (e && e.message ? e.message : String(e)) };
  }
  if (!el) return { ok: false, error: 'Selector matched nothing on this page.' };

  // Gated, not simply forced: the library's verify() calls `new Function` at
  // cssHoverToJavascript.js:1178 inside a try/finally that does not catch, so on a
  // page whose CSP forbids eval, asking for it would throw out of cssHoverToJS and
  // cost us the entire result rather than just the verification.
  let evalOk = false;
  try {
    evalOk = new Function('return 1')() === 1;
  } catch { /* page CSP forbids 'unsafe-eval' */ }

  let res;
  try {
    res = window.cssHoverToJS(el, {
      applyOnly: true, // the panel's own button covers apply/clear; the user sees only the apply form
      verify: evalOk,
      log: false, // logReport() below replaces the library's own console output
    });
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return {
      ok: false,
      error: msg,
      cspBlocked: (e && e.name === 'EvalError') || /unsafe-eval|Content Security Policy/i.test(msg),
    };
  }

  const affected = (res.affected || []).map((rec) => ({
    desc: desc(rec.el),
    decls: Object.entries(rec.decls || {}).map(([prop, v]) => [prop, v[0], v[1] === 'important']),
    pseudos: [...new Set((rec.pseudoHits || []).map((h) => h.pe))].filter(Boolean),
    viaCss: !!rec.viaCss,
    hasRemoval: !!rec.hasRemoval,
  }));
  const warnings = res.warnings || [];

  /**
   * The console half of the report, printed on every run. Warnings live here and
   * nowhere else -- the panel deliberately shows none of them, so this is the only
   * place the full set is readable, and that is precisely why it is not optional.
   * Stands in for the library's own report(), which under applyOnly prints just the
   * snippet and "re-run without { applyOnly: true } to see them"
   * (cssHoverToJavascript.js:1233) -- advice with no corresponding control here.
   */
  const label = `cssHoverToJS  ${desc(res.target) || selector}`;
  console.groupCollapsed(`%c${label}`, 'font-weight:bold');
  if (!res.groups || !res.groups.length) {
    console.log(
      res.matchedButNoEffect
        ? 'Hover rules match here, but none of them win the cascade -- hovering changes nothing.'
        : 'No hover styling is reachable from this element.'
    );
  } else {
    console.log(`hover root: ${desc(res.hoverRoot)}   mode: ${res.mode}`);
    console.table(
      res.groups.map((g, i) => ({
        '#': i + 1,
        'hovered element': desc(g.host),
        elements: g.elements.length,
        properties: g.props,
        'affects target': g.touchesTarget ? 'yes' : 'elsewhere on page',
      }))
    );
    for (const rec of affected) {
      const props = rec.decls.map(([p, v, imp]) => `${p}: ${v}${imp ? ' !important' : ''}`).join('; ');
      const pe = rec.pseudos.length ? ` + ${rec.pseudos.join(', ')} (via stylesheet)` : '';
      console.log(`%c${rec.desc}%c  ${props}${pe}`, 'color:#08f', '');
    }
  }
  for (const w of warnings) console.warn(w);
  if (res.verification) {
    const v = res.verification;
    console.log(
      `%cverify: ${v.pass ? 'PASS -- matches the real hover state' : `FAIL -- ${v.diffs.length} mismatch(es)`}`,
      `color:${v.pass ? '#0a0' : '#c00'};font-weight:bold`
    );
    if (!v.pass) console.table(v.diffs.map((d) => ({ element: desc(d.el), prop: d.prop, expected: d.expected, got: d.got, kind: d.kind })));
  } else {
    console.log('verify: skipped -- this page’s CSP forbids eval.');
  }
  if (res.snippet) console.log(res.snippet);
  console.groupEnd();

  return {
    ok: true,
    version: window.cssHoverToJS.version || null,
    // Two distinct "found nothing" outcomes the UI has to word differently:
    // no hover rules reach here at all, versus rules match but lose the cascade.
    empty: !res.groups || !res.groups.length,
    matchedButNoEffect: !!res.matchedButNoEffect,
    targetDesc: desc(res.target),
    hoverRootDesc: desc(res.hoverRoot),
    mode: res.mode,
    groups: (res.groups || []).map((g) => ({
      hostDesc: desc(g.host),
      elements: g.elements.length,
      props: g.props,
      touchesTarget: !!g.touchesTarget,
    })),
    affected,
    // Whether verification actually ran, so the panel can tell "passed" apart
    // from "could not be checked". The full warning list stays in the console.
    verified: evalOk,
    incomplete: warnings.filter((w) => UNREADABLE.test(w)),
    // Only surfaced on failure; the library's applyOnly `note` is dropped because
    // it says residue checks do not apply to the emitted snippet -- true, but
    // misleading here, since the panel's button drives the toggle form and those
    // residue checks do cover it.
    verification:
      res.verification && !res.verification.pass
        ? {
            diffs: (res.verification.diffs || []).map((d) => ({
              desc: desc(d.el),
              prop: d.prop,
              expected: d.expected,
              got: d.got,
              kind: d.kind,
            })),
          }
        : null,
    // The apply-only form: what the user copies into a visual test.
    snippet: res.snippet,
    // The toggle form, never shown -- it is what the panel's hover button drives,
    // because it is the only one with a restore path.
    verifySnippet: (res._internals && res._internals.verifySnippet) || res.snippet,
  };
}

/** Eval the toggle snippet and force the hover state on. */
export function applySnippet(code) {
  try {
    // Restore whatever a previous snippet applied first. Each snippet owns its own
    // captured style/class attributes, so applying a second one while the first is
    // still live would orphan the first's inline styles with nothing able to undo them.
    const stale = window.__csshApi;
    if (stale && typeof stale.clearHover === 'function') {
      try { stale.clearHover(); } catch { /* a re-render can leave it pointing at nothing */ }
    }
    const api = new Function('return ' + code)();
    window.__csshApi = api;
    api.applyHover();
    return { ok: true };
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return {
      ok: false,
      error: msg,
      cspBlocked: (e && e.name === 'EvalError') || /unsafe-eval|Content Security Policy/i.test(msg),
    };
  }
}

/**
 * Restore the page. Falls back to the global the snippet also assigns, which is
 * how a snippet the user ran in their own console gets cleared from here.
 *
 * Idempotent: the snippet carries a re-entry guard, so a second call is a no-op
 * rather than an error. `__csshApi` is deliberately kept, not deleted, so repeat
 * clears keep hitting the same snippet instead of falling through to a stale global.
 */
export function clearSnippet() {
  try {
    const api = window.__csshApi;
    if (api && typeof api.clearHover === 'function') api.clearHover();
    else if (typeof window.clearHover === 'function') window.clearHover();
    else return { ok: false, error: 'Nothing to clear -- no snippet has been applied in this world.' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/** How many elements the selector currently matches, for the live indicator. */
export function probeSelector(selector) {
  const desc = (el) =>
    !el
      ? null
      : el === document.documentElement
        ? 'html'
        : el.localName +
          (el.id ? '#' + el.id : '') +
          // Skip the snippet's own marker class -- that is our residue, not the
          // page's, and it only appears while a hover is applied.
          [...el.classList].filter((c) => c !== 'cssh-on').slice(0, 2).map((c) => '.' + c).join('');
  try {
    const segs = selector.split('>>>').map((s) => s.trim()).filter(Boolean);
    if (!segs.length) return { ok: true, count: 0, desc: null };
    // Walk every segment but the last to reach the right root, then count there.
    let node = document;
    for (const seg of segs.slice(0, -1)) {
      node = (node.shadowRoot || node).querySelector(seg);
      if (!node) return { ok: true, count: 0, desc: null };
    }
    const list = (node.shadowRoot || node).querySelectorAll(segs[segs.length - 1]);
    return { ok: true, count: list.length, desc: list.length ? desc(list[0]) : null };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/**
 * Flash a box over the resolved element.
 *
 * Deliberately an absolutely-positioned overlay rather than an outline on the
 * element itself: writing to `element.style` would corrupt the very `style`
 * attribute that clearHover() restores byte-for-byte.
 */
export function flashSelector(selector, ms) {
  const resolve = (sel) => {
    const segs = sel.split('>>>').map((s) => s.trim()).filter(Boolean);
    if (!segs.length) return null;
    let node = document;
    for (const seg of segs) {
      node = (node.shadowRoot || node).querySelector(seg);
      if (!node) return null;
    }
    return node;
  };
  try {
    const el = resolve(selector);
    if (!el) return { ok: false, error: 'Selector matched nothing.' };
    // Scroll only when it is actually off-screen, and instantly -- a smooth
    // scroll would still be animating when getBoundingClientRect() is read,
    // putting the box in the wrong place.
    let r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      r = el.getBoundingClientRect();
    }
    let host = document.getElementById('__cssh-flash');
    if (!host) {
      host = document.createElement('div');
      host.id = '__cssh-flash';
      host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647';
      // Closed shadow root so no page stylesheet can restyle the box.
      const root = host.attachShadow({ mode: 'closed' });
      const box = document.createElement('div');
      box.id = 'box';
      root.appendChild(box);
      document.documentElement.appendChild(host);
      host.__box = box;
    }
    const box = host.__box;
    box.style.cssText =
      'position:fixed;pointer-events:none;box-sizing:border-box;' +
      'border:2px solid #7aa2f7;background:rgba(122,162,247,.18);border-radius:2px;' +
      'transition:opacity .15s;opacity:1;' +
      `top:${r.top}px;left:${r.left}px;width:${r.width}px;height:${r.height}px`;
    clearTimeout(host.__t);
    host.__t = setTimeout(() => host.remove(), ms || 1200);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}
