/**
 * DevTools-style element picker, injected on demand into the ISOLATED world so
 * page scripts can neither see nor clobber it.
 *
 * It produces a selector STRING, which is the same thing the panel's manual input
 * produces -- one resolution path, and what the user reads in the field is exactly
 * what gets analyzed. Shadow boundaries are written `host >>> inner`.
 *
 * The selector logic mirrors the library's own private `selectorWithin`/`pathTo`
 * (cssHoverToJavascript.js:681-730) so a picked selector agrees with the paths the
 * generated snippets use: id, then a test/name attribute, then classes plus
 * :nth-of-type, verified unique at every step.
 */
(() => {
  if (window.__csshPicker) return; // already picking

  const ON_CLASS = 'cssh-on'; // the snippet's own marker class -- never key off it

  /* --------------------------- selector generation --------------------------- */

  const okIdent = (s) => /^-?[A-Za-z_][\w-]*$/.test(s);

  const unique = (root, sel, el) => {
    try {
      const l = root.querySelectorAll(sel);
      return l.length === 1 && l[0] === el;
    } catch {
      return false;
    }
  };

  const ambiguous = (parent, compound) => {
    try {
      return parent.querySelectorAll(`:scope > ${compound}`).length > 1;
    } catch {
      return true;
    }
  };

  function selectorWithin(el, root) {
    if (el.id && okIdent(el.id) && unique(root, `#${CSS.escape(el.id)}`, el)) return `#${CSS.escape(el.id)}`;
    for (const attr of ['data-testid', 'data-test', 'data-qa', 'data-cy', 'name', 'aria-label']) {
      const v = el.getAttribute && el.getAttribute(attr);
      if (v) {
        const sel = `${el.localName}[${attr}="${CSS.escape(v).replace(/\\ /g, ' ')}"]`;
        if (unique(root, sel, el)) return sel;
      }
    }
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== root) {
      if (cur.id && okIdent(cur.id)) {
        parts.unshift(`#${CSS.escape(cur.id)}`);
      } else {
        let s = cur.localName;
        s += [...cur.classList]
          .filter((c) => okIdent(c) && c !== ON_CLASS)
          .slice(0, 2)
          .map((c) => `.${CSS.escape(c)}`)
          .join('');
        const par = cur.parentElement;
        if (par && ambiguous(par, s)) {
          const sibs = [...par.children].filter((x) => x.localName === cur.localName);
          if (sibs.length > 1) s += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
        }
        parts.unshift(s);
      }
      const cand = parts.join(' > ');
      if (unique(root, cand, el)) return cand;
      cur = cur.parentElement;
    }
    return parts.join(' > ') || el.localName;
  }

  /** One segment per shadow boundary crossed, outermost first. */
  function pathTo(el) {
    const segs = [];
    let node = el;
    let root = el.getRootNode();
    for (let guard = 0; guard < 20; guard++) {
      segs.unshift(selectorWithin(node, root));
      if (!root.host) break;
      node = root.host;
      root = node.getRootNode();
    }
    return segs;
  }

  const describe = (el) =>
    el === document.documentElement
      ? 'html'
      : el.localName +
        (el.id ? `#${el.id}` : '') +
        [...el.classList].filter((c) => c !== ON_CLASS).slice(0, 2).map((c) => `.${c}`).join('');

  /* -------------------------------- overlay -------------------------------- */

  const host = document.createElement('div');
  host.id = '__cssh-picker';
  host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;pointer-events:none;z-index:2147483647';
  // Closed shadow root: no page stylesheet can reach in and restyle the chrome.
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      :host { all: initial }
      div { position: fixed; pointer-events: none; box-sizing: border-box;
            font: 500 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace }
      #box { border: 1px solid #7aa2f7; background: rgba(122,162,247,.16); border-radius: 2px }
      #tag { background: #7aa2f7; color: #0d1117; padding: 2px 6px; border-radius: 3px;
             white-space: nowrap; max-width: 90vw; overflow: hidden; text-overflow: ellipsis }
      #tag:empty { display: none }   /* before the first pointermove */
      #hint { left: 50%; transform: translateX(-50%); bottom: 12px; background: #171a1f; color: #c9d1d9;
              padding: 6px 12px; border-radius: 6px; box-shadow: 0 4px 16px rgba(0,0,0,.4) }
      b { color: #7aa2f7 }
    </style>
    <div id="box"></div>
    <div id="tag"></div>
    <div id="hint"><b>Click</b> to select &nbsp;·&nbsp; <b>Esc</b> to cancel</div>`;
  const box = root.getElementById('box');
  const tag = root.getElementById('tag');
  document.documentElement.appendChild(host);

  // Cursor has to be a page-level rule, not an inline style: writing to any
  // element's style attribute is exactly what clearHover() restores byte-for-byte.
  const cursorCss = document.createElement('style');
  cursorCss.textContent = '*,*::before,*::after{cursor:crosshair !important}';
  (document.head || document.documentElement).appendChild(cursorCss);

  let current = null;

  function draw(el) {
    const r = el.getBoundingClientRect();
    box.style.top = `${r.top}px`;
    box.style.left = `${r.left}px`;
    box.style.width = `${r.width}px`;
    box.style.height = `${r.height}px`;
    tag.textContent = `${describe(el)}  ${Math.round(r.width)}×${Math.round(r.height)}`;
    // Prefer the label above the box; flip below when it would clip off-screen.
    const above = r.top >= 22;
    tag.style.top = `${above ? r.top - 21 : Math.min(r.bottom + 4, innerHeight - 22)}px`;
    tag.style.left = `${Math.max(2, Math.min(r.left, innerWidth - 240))}px`;
  }

  /* ------------------------------- lifecycle ------------------------------- */

  function teardown() {
    for (const [type, fn] of listeners) window.removeEventListener(type, fn, true);
    chrome.runtime.onMessage.removeListener(onMessage);
    host.remove();
    cursorCss.remove();
    delete window.__csshPicker;
  }

  const swallow = (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  const onMove = (e) => {
    // composedPath()[0] is the node a real mouse hovers, including inside an open
    // shadow root -- a listener on window sees only the retargeted host.
    const el = e.composedPath()[0] || e.target;
    if (!el || el.nodeType !== 1 || el === host) return;
    current = el;
    draw(el);
  };

  const onClick = (e) => {
    swallow(e);
    const el = current || e.composedPath()[0] || e.target;
    if (!el || el.nodeType !== 1) return;
    const selector = pathTo(el).join(' >>> ');
    teardown();
    chrome.runtime.sendMessage({ type: 'picked', selector, desc: describe(el) });
  };

  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    swallow(e);
    teardown();
    chrome.runtime.sendMessage({ type: 'pickerCancelled' });
  };

  function onMessage(msg) {
    if (msg && msg.type === 'cssh-stop-picker') teardown();
  }

  const listeners = [
    ['pointermove', onMove],
    ['pointerdown', swallow],
    ['mousedown', swallow],
    ['mouseup', swallow],
    ['contextmenu', swallow],
    ['dblclick', swallow],
    ['click', onClick],
    ['keydown', onKey],
  ];
  for (const [type, fn] of listeners) window.addEventListener(type, fn, true);
  chrome.runtime.onMessage.addListener(onMessage);

  window.__csshPicker = { teardown };
})();
