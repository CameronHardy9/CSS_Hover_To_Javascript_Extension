/**
 * cssHoverToJavascript.js
 * ----------------------------------------------------------------------------
 * Paste into a browser console, select an element in the Elements panel, run:
 *
 *     cssHoverToJS($0)
 *     cssHoverToJS($0, { verify: true })     // prove the output matches CSS
 *     cssHoverToJS($0, { format: 'css' })    // force stylesheet mode
 *     cssHoverToJS($0, { applyOnly: true })  // print only the code that applies it
 *
 * It figures out everything CSS would change when that element is hovered --
 * including changes CSS makes to *other* elements -- and prints a standalone
 * snippet exposing applyHover() / clearHover().
 *
 * With { applyOnly: true } the console output is just the statements that force
 * the hover state -- no report, no clearHover(), nothing restored.
 *
 * HOW IT KNOWS
 * :hover cannot be triggered from JS, but it can be *rewritten*. Swapping
 * `:hover` for `[data-cssh-probe]` in a selector and stamping that attribute
 * on an element makes querySelectorAll return exactly the elements CSS would
 * restyle when that element is hovered -- for any combinator, and for
 * :has(:hover). Rewriting `selectorText` in place (then restoring it) also
 * yields a true hover-state computed-style snapshot to verify against.
 *
 * Hover propagates up the DOM: pointing at an element hovers it AND every
 * ancestor. So the real state is the union of contributions along the whole
 * chain; the parent-most contributor is reported as the hover root.
 *
 * Values are carried through AS AUTHORED -- var(), calc(), clamp(), custom
 * properties, !important -- never as resolved computed values, so design
 * tokens and cascade logic survive into the JavaScript.
 * ----------------------------------------------------------------------------
 */
(() => {
  'use strict';

  const PROBE = 'data-cssh-probe';
  const PROBE_SEL = `[${PROBE}]`;
  // Stands in for :hover in the NOT-hovered state. Nothing ever carries this
  // attribute, so `li:not(:hover)` -> `li:not([data-cssh-never])` matches every
  // li, exactly as it does when nothing is hovered. Same specificity as :hover.
  const NEVER_SEL = '[data-cssh-never]';
  const ON_CLASS = 'cssh-on';
  // Timing-dependent properties: getComputedStyle can't be trusted to tell us
  // whether these changed, so they are judged by declaration only.
  const NO_COMPUTED_FILTER = /^(transition|animation)(-|$)/;

  /* ======================= selector text utilities ======================= */

  /** Split on `sep` at paren/bracket/string depth 0. */
  function splitTop(str, sep) {
    const out = [];
    let buf = '', depth = 0, q = null;
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if (q) {
        buf += c;
        if (c === '\\') buf += str[++i] || '';
        else if (c === q) q = null;
        continue;
      }
      if (c === '"' || c === "'") { q = c; buf += c; continue; }
      if (c === '\\') { buf += c + (str[++i] || ''); continue; }
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      if (c === sep && depth <= 0) { out.push(buf); buf = ''; continue; }
      buf += c;
    }
    out.push(buf);
    return out.map((s) => s.trim()).filter(Boolean);
  }

  /** Replace every `:hover` (outside strings, not `:hoverable`) with `rep`. */
  function replaceHover(sel, rep) {
    let out = '', n = 0, q = null;
    for (let i = 0; i < sel.length; i++) {
      const c = sel[i];
      if (q) {
        out += c;
        if (c === '\\') out += sel[++i] || '';
        else if (c === q) q = null;
        continue;
      }
      if (c === '"' || c === "'") { q = c; out += c; continue; }
      if (c === '\\') { out += c + (sel[++i] || ''); continue; }
      if (c === ':' && sel[i - 1] !== ':' && sel.substr(i, 6).toLowerCase() === ':hover') {
        const next = sel[i + 6];
        if (!next || !/[\w\-(]/.test(next)) { out += rep; i += 5; n++; continue; }
      }
      out += c;
    }
    return { text: out, count: n };
  }

  const hoverCount = (sel) => replaceHover(sel, '').count;

  /** The subject compound: everything after the last top-level combinator. */
  function lastCompound(sel) {
    let idx = 0, depth = 0, q = null;
    for (let i = 0; i < sel.length; i++) {
      const c = sel[i];
      if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === '\\') { i++; continue; }
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      else if (depth <= 0 && (c === ' ' || c === '\t' || c === '\n' || c === '>' || c === '+' || c === '~')) idx = i + 1;
    }
    return { text: sel.slice(idx), start: idx };
  }

  const LEGACY_PE = new Set(['before', 'after', 'first-line', 'first-letter']);

  /**
   * Locate a pseudo-element in a compound selector.
   * Returns { name, at } (index within the compound) or null.
   */
  function findPseudoElement(compound) {
    let depth = 0, q = null;
    for (let i = 0; i < compound.length; i++) {
      const c = compound[i];
      if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === '(' || c === '[') { depth++; continue; }
      if (c === ')' || c === ']') { depth--; continue; }
      if (depth > 0) continue;
      if (c === ':') {
        const dbl = compound[i + 1] === ':';
        const m = /^[\w-]+/.exec(compound.slice(i + (dbl ? 2 : 1)));
        if (!m) continue;
        const name = m[0].toLowerCase();
        if (dbl || LEGACY_PE.has(name)) return { name: (dbl ? '::' : ':') + name, at: i };
        i += m[0].length;
      }
    }
    return null;
  }

  /** Pseudo-element targeted by a single (comma-free) selector, or null. */
  function subjectPseudoElement(sel) {
    const pe = findPseudoElement(lastCompound(sel).text);
    return pe ? pe.name : null;
  }

  /**
   * Strip the pseudo-element from the subject compound so the selector can be
   * handed to querySelectorAll / matches (which reject pseudo-elements).
   */
  function stripPseudoElement(sel) {
    const { text, start } = lastCompound(sel);
    const pe = findPseudoElement(text);
    if (!pe) return sel;
    let head = sel.slice(0, start) + text.slice(0, pe.at);
    head = head.trim();
    // `::before` alone leaves an empty compound -- it implies the parent element.
    if (!head || /[>+~]$/.test(head)) head += ' *';
    return head;
  }

  /* ---------------------------- specificity ---------------------------- */

  const cmpSpec = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

  function specificity(sel) {
    const tot = [0, 0, 0];
    let i = 0;
    const readIdent = () => {
      let s = '';
      while (i < sel.length && /[\w-]/.test(sel[i])) s += sel[i++];
      return s;
    };
    const readParen = () => { // sel[i] === '('
      let depth = 0, s = '', q = null;
      for (; i < sel.length; i++) {
        const c = sel[i];
        if (q) { s += c; if (c === '\\') s += sel[++i] || ''; else if (c === q) q = null; continue; }
        if (c === '"' || c === "'") { q = c; s += c; continue; }
        if (c === '(') { depth++; if (depth === 1) continue; }
        else if (c === ')') { depth--; if (depth === 0) { i++; return s; } }
        s += c;
      }
      return s;
    };
    while (i < sel.length) {
      const c = sel[i];
      if (c === '\\') { i += 2; tot[2]++; continue; }
      if (c === '#') { i++; readIdent(); tot[0]++; continue; }
      if (c === '.') { i++; readIdent(); tot[1]++; continue; }
      if (c === '[') {
        let depth = 0, q = null;
        for (; i < sel.length; i++) {
          const ch = sel[i];
          if (q) { if (ch === '\\') i++; else if (ch === q) q = null; continue; }
          if (ch === '"' || ch === "'") { q = ch; continue; }
          if (ch === '[') depth++;
          else if (ch === ']') { depth--; if (!depth) { i++; break; } }
        }
        tot[1]++;
        continue;
      }
      if (c === ':') {
        if (sel[i + 1] === ':') {
          i += 2; readIdent();
          if (sel[i] === '(') readParen();
          tot[2]++;
          continue;
        }
        i++;
        const name = readIdent().toLowerCase();
        const arg = sel[i] === '(' ? readParen() : null;
        if (LEGACY_PE.has(name)) { tot[2]++; continue; }
        if (name === 'where') continue;
        if (name === 'is' || name === 'not' || name === 'has' || name === 'matches' || name === 'any') {
          const s = maxSpec(arg || '');
          tot[0] += s[0]; tot[1] += s[1]; tot[2] += s[2];
          continue;
        }
        if ((name === 'nth-child' || name === 'nth-last-child') && arg) {
          tot[1]++;
          const of = /\bof\b([\s\S]*)$/i.exec(arg);
          if (of) { const s = maxSpec(of[1]); tot[0] += s[0]; tot[1] += s[1]; tot[2] += s[2]; }
          continue;
        }
        tot[1]++;
        continue;
      }
      if (c === '*') { i++; continue; }
      if (/[\w-]/.test(c)) {
        readIdent();
        if (sel[i] === '|') { i++; readIdent(); } // namespace prefix
        tot[2]++;
        continue;
      }
      i++; // combinator / whitespace / other
    }
    return tot;
  }

  const maxSpec = (list) =>
    splitTop(list, ',').map(specificity).reduce((m, s) => (cmpSpec(s, m) > 0 ? s : m), [0, 0, 0]);

  /* ============================ CSS collection ============================ */

  const is = (rule, ctor) => typeof window[ctor] === 'function' && rule instanceof window[ctor];

  /** Every root whose stylesheets we can read: document + open shadow roots. */
  function allRoots() {
    const roots = [document];
    let closedSuspects = 0;
    const visit = (root) => {
      let els;
      try { els = root.querySelectorAll('*'); } catch { return; }
      for (const el of els) {
        if (el.shadowRoot) { roots.push(el.shadowRoot); visit(el.shadowRoot); }
        else if (el.localName.includes('-') && !el.firstElementChild) closedSuspects++;
      }
    };
    visit(document);
    return { roots, closedSuspects };
  }

  /** Resolve a nested selector against its parent selector list (CSS nesting). */
  function resolveNested(nested, parentSel) {
    const parent = `:is(${parentSel})`;
    return splitTop(nested, ',')
      .map((branch) => {
        if (/&/.test(branch)) return branch.replace(/&/g, parent);
        return `${parent} ${branch}`;
      })
      .join(', ');
  }

  /**
   * Walk every reachable stylesheet, flattening grouping rules and CSS nesting
   * into absolute selectors while preserving conditions, layer and source order.
   */
  function collectRules() {
    const warnings = [];
    const rules = [];
    const layerIndex = new Map();
    const { roots, closedSuspects } = allRoots();
    const seen = new Set();
    let order = 0;

    const noteLayer = (name) => {
      if (name && !layerIndex.has(name)) layerIndex.set(name, layerIndex.size);
    };

    const walkList = (list, scope, ctx) => {
      for (const rule of list) {
        // Bare declarations following nested rules -- they belong to the parent.
        if (rule.style && rule.selectorText === undefined && !rule.cssRules) {
          if (ctx.parentSel) {
            rules.push(makeEntry(rule, ctx.parentSel, scope, ctx, order++, true));
          }
          continue;
        }
        if (is(rule, 'CSSStyleRule')) {
          const sel = ctx.parentSel ? resolveNested(rule.selectorText, ctx.parentSel) : rule.selectorText;
          rules.push(makeEntry(rule, sel, scope, ctx, order++, false));
          if (rule.cssRules && rule.cssRules.length) {
            walkList(rule.cssRules, scope, { ...ctx, parentSel: sel });
          }
          continue;
        }
        if (is(rule, 'CSSLayerStatementRule') || (rule.nameList && !rule.cssRules)) {
          for (const n of rule.nameList || []) noteLayer(n);
          continue;
        }
        if (is(rule, 'CSSImportRule')) {
          if (rule.layerName) noteLayer(rule.layerName);
          if (rule.styleSheet) walkSheet(rule.styleSheet, scope, ctx);
          continue;
        }
        if (rule.cssRules) {
          const next = { ...ctx, conditions: ctx.conditions.slice() };
          if (is(rule, 'CSSLayerBlockRule') || (rule.name !== undefined && rule.cssRules && !rule.conditionText)) {
            noteLayer(rule.name || '');
            next.layer = rule.name || '';
          } else if (is(rule, 'CSSMediaRule')) {
            next.conditions.push({ type: 'media', text: rule.conditionText || rule.media.mediaText });
          } else if (is(rule, 'CSSSupportsRule')) {
            next.conditions.push({ type: 'supports', text: rule.conditionText });
          } else if (is(rule, 'CSSContainerRule')) {
            next.conditions.push({ type: 'container', text: rule.conditionText });
          } else if (rule.conditionText) {
            next.conditions.push({ type: 'unknown', text: rule.conditionText });
          }
          walkList(rule.cssRules, scope, next);
        }
      }
    };

    const walkSheet = (sheet, scope, ctx) => {
      if (seen.has(sheet)) return;
      seen.add(sheet);
      let list;
      try { list = sheet.cssRules; } catch {
        warnings.push(
          `Cross-origin stylesheet is unreadable, its hover rules are invisible: ${sheet.href || '<inline>'}`
        );
        return;
      }
      if (!list) return;
      const own = sheet.ownerNode ? sheet.ownerNode.getRootNode() : scope;
      walkList(list, own === document || own.host ? own : scope, ctx);
    };

    const baseCtx = { conditions: [], layer: null, parentSel: null };
    for (const root of roots) {
      for (const sheet of root.styleSheets || []) walkSheet(sheet, root, baseCtx);
      for (const sheet of root.adoptedStyleSheets || []) walkSheet(sheet, root, baseCtx);
    }

    if (closedSuspects) {
      warnings.push(
        `${closedSuspects} custom element(s) expose no open shadowRoot; styles inside a closed shadow root cannot be read.`
      );
    }
    return { rules, warnings, layerIndex };
  }

  function makeEntry(rule, sel, scope, ctx, order, isNestedDecls) {
    const branches = splitTop(sel, ',');
    const decls = authoredDecls(rule.style);
    const owner = ownerMap(decls);
    return {
      rule,
      sel,
      branches,
      hoverBranches: branches.filter((b) => hoverCount(b) > 0),
      hovers: hoverCount(sel),
      scope,
      conditions: ctx.conditions,
      layer: ctx.layer,
      order,
      isNestedDecls,
      decls,
      owner,
      props: [...owner.keys()],
    };
  }

  /**
   * Declarations as authored: `background: var(--x)` stays one shorthand entry.
   * This matters because the engine enumerates a var()-containing shorthand as
   * longhands whose individual values are EMPTY (pending substitution) -- the
   * authored shorthand is the only place the token still exists.
   */
  function authoredDecls(style) {
    const out = [];
    for (const decl of splitTop(style.cssText || '', ';')) {
      const i = decl.indexOf(':');
      if (i < 0) continue;
      const name = decl.slice(0, i).trim();
      if (!name) continue;
      let value = decl.slice(i + 1).trim();
      let priority = '';
      if (/!\s*important$/i.test(value)) {
        value = value.replace(/!\s*important$/i, '').trim();
        priority = 'important';
      }
      out.push({ name, value, priority, longhands: expandLonghands(name, value) });
    }
    return out;
  }

  /** longhand -> index of the declaration that last set it (within one block). */
  function ownerMap(decls) {
    const owner = new Map();
    decls.forEach((d, i) => d.longhands.forEach((lh) => owner.set(lh, i)));
    return owner;
  }

  const expandCache = new Map();

  /** Which longhands does `name: value` set? Asks the engine, no lookup table. */
  function expandLonghands(name, value) {
    if (name.startsWith('--')) return [name];
    const key = `${name}\u0000${value}`;
    const hit = expandCache.get(key);
    if (hit) return hit;
    const s = scratch();
    try { s.cssText = `${name}:${value}`; } catch { /* keep going */ }
    const list = [];
    for (let i = 0; i < s.length; i++) list.push(s.item(i));
    if (!list.length) list.push(name);
    expandCache.set(key, list);
    return list;
  }

  /** Are this rule's conditions currently satisfied? */
  function conditionsActive(entry, warnings) {
    for (const c of entry.conditions) {
      if (c.type === 'media') {
        try { if (!matchMedia(c.text).matches) return false; } catch { /* keep */ }
      } else if (c.type === 'supports') {
        try { if (!CSS.supports(c.text)) return false; } catch { /* keep */ }
      } else if (c.type === 'container') {
        warnings.add(`@container (${c.text}) cannot be evaluated from script; its rules are assumed to apply.`);
      }
    }
    return true;
  }

  /* ============================== probing ============================== */

  const matchesIn = (el, sel, scope) => {
    if (el.getRootNode() !== scope) return false;
    try { return el.matches(sel); } catch { return false; }
  };

  const queryAll = (scope, sel) => {
    const queryable = subjectPseudoElement(sel) ? stripPseudoElement(sel) : sel;
    try { return [...scope.querySelectorAll(queryable)]; } catch { return null; }
  };

  /**
   * Elements whose styling changes if exactly `hosts` were hovered.
   *
   * This is the symmetric difference between what a selector matches while
   * hovered and what it matches while not hovered -- which catches inverted
   * rules like `li:not(:hover)`, where hovering REMOVES a declaration, and
   * skips elements a rule matches in both states (no change there).
   */
  function probeHits(hosts, hoverRules) {
    for (const h of hosts) h.setAttribute(PROBE, '');
    const hits = [];
    try {
      for (const entry of hoverRules) {
        for (const branch of entry.hoverBranches) {
          const probed = replaceHover(branch, PROBE_SEL).text;
          const pe = subjectPseudoElement(probed);
          const on = queryAll(entry.scope, probed);
          if (!on) continue;
          const off = queryAll(entry.scope, replaceHover(branch, NEVER_SEL).text) || [];
          const offSet = new Set(off);
          const onSet = new Set(on);
          for (const el of on) if (!offSet.has(el)) hits.push({ el, entry, branch, pe });
          for (const el of off) if (!onSet.has(el)) hits.push({ el, entry, branch, pe });
        }
      }
    } finally {
      for (const h of hosts) h.removeAttribute(PROBE);
    }
    return hits;
  }

  /**
   * Run `fn` with the page in its true hover state: hover rules rewritten in
   * place (preserving cascade position exactly) and the probe attribute
   * stamped on the hover chain. Everything is restored afterwards.
   */
  function withHoverForced(hoverRules, hosts, fn, warnings) {
    const undo = [];
    let fallbackSheet = null;
    const fallbackText = [];
    try {
      for (const entry of hoverRules) {
        if (entry.isNestedDecls) continue; // covered by its parent rule
        const original = entry.rule.selectorText;
        // A nested rule like `& > .c` inherits :hover from its parent rule;
        // there is nothing local to rewrite and the parent handles it.
        if (hoverCount(original) === 0) continue;
        const probed = replaceHover(original, PROBE_SEL).text;
        try {
          entry.rule.selectorText = probed;
        } catch { /* fall through to the check below */ }
        if (entry.rule.selectorText === original) {
          fallbackText.push(wrapConditions(entry, `${replaceHover(entry.sel, PROBE_SEL).text}{${entry.rule.style.cssText}}`));
          if (warnings) warnings.add('Some rules could not be rewritten in place; ground truth for them used an appended stylesheet (cascade position approximated).');
        } else {
          undo.push([entry.rule, original]);
        }
      }
      if (fallbackText.length) {
        fallbackSheet = document.createElement('style');
        fallbackSheet.textContent = fallbackText.join('\n');
        document.head.appendChild(fallbackSheet);
      }
      for (const h of hosts) h.setAttribute(PROBE, '');
      return fn();
    } finally {
      for (const h of hosts) h.removeAttribute(PROBE);
      if (fallbackSheet) fallbackSheet.remove();
      for (const [rule, sel] of undo) {
        try { rule.selectorText = sel; } catch { /* nothing else we can do */ }
      }
    }
  }

  function wrapConditions(entry, inner) {
    let text = inner;
    for (let i = entry.conditions.length - 1; i >= 0; i--) {
      const c = entry.conditions[i];
      const at = c.type === 'media' ? '@media' : c.type === 'supports' ? '@supports' : '@container';
      text = `${at} ${c.text}{${text}}`;
    }
    if (entry.layer) text = `@layer ${entry.layer}{${text}}`;
    return text;
  }

  /* ============================== cascade ============================== */

  /**
   * Which declaration wins? Ordering per CSS cascade: importance, then layer
   * (reversed for !important, unlayered treated as the last layer), then
   * specificity, then source order. Inline styles sit above author rules.
   */
  function cascadeWins(a, b, layerIndex) {
    if (a.important !== b.important) return a.important ? 1 : -1;
    const ra = a.inline ? Infinity : a.layer ? layerIndex.get(a.layer) ?? 0 : Infinity;
    const rb = b.inline ? Infinity : b.layer ? layerIndex.get(b.layer) ?? 0 : Infinity;
    if (ra !== rb && !(a.inline && b.inline)) {
      if (a.inline !== b.inline) return a.inline ? 1 : -1;
      return a.important ? (ra < rb ? 1 : -1) : ra > rb ? 1 : -1;
    }
    if (a.inline !== b.inline) return a.inline ? 1 : -1;
    const s = cmpSpec(a.spec, b.spec);
    if (s) return s;
    return a.order - b.order;
  }

  /**
   * Winning declaration for each candidate property on `el`, considering every
   * rule that matches in the given state plus the element's style attribute.
   */
  function winners(el, candidates, entries, hoverState, layerIndex) {
    const best = new Map();
    const consider = (cand) => {
      const cur = best.get(cand.prop);
      if (!cur || cascadeWins(cand, cur, layerIndex) > 0) best.set(cand.prop, cand);
    };
    const fromBlock = (decls, owner, meta) => {
      for (const [prop, idx] of owner) {
        if (!candidates.has(prop)) continue;
        const decl = decls[idx];
        consider({
          ...meta,
          prop,
          decl,
          declKey: `${meta.key}:${idx}`,
          value: decl.value,
          important: decl.priority === 'important',
        });
      }
    };
    for (const entry of entries) {
      if (!entry.props.some((p) => candidates.has(p))) continue;
      let spec = null;
      for (const branch of entry.branches) {
        // In the un-hovered state :hover matches nothing -- which is not the
        // same as ignoring the rule, because `:not(:hover)` then matches.
        const sel = hoverCount(branch)
          ? replaceHover(branch, hoverState ? PROBE_SEL : NEVER_SEL).text
          : branch;
        if (subjectPseudoElement(sel)) continue; // pseudo-elements handled separately
        if (!matchesIn(el, sel, entry.scope)) continue;
        const s = specificity(sel);
        if (!spec || cmpSpec(s, spec) > 0) spec = s; // most specific matching branch wins
      }
      if (!spec) continue;
      fromBlock(entry.decls, entry.owner, {
        key: `r${entry.order}`,
        spec,
        order: entry.order,
        layer: entry.layer,
        entry,
        inline: false,
      });
    }
    if (el.style && el.style.length) {
      const decls = authoredDecls(el.style);
      fromBlock(decls, ownerMap(decls), {
        key: 'inline',
        spec: [0, 0, 0],
        order: Infinity,
        layer: null,
        entry: null,
        inline: true,
      });
    }
    return best;
  }

  /* ============================ declarations ============================ */

  const scratch = () => document.createElement('div').style;

  const serializeDecls = (map) =>
    Object.entries(map)
      .map(([k, [v, p]]) => `${k}:${v}${p ? ' !important' : ''}`)
      .join(';');

  /**
   * Let the engine collapse longhands back into shorthands (margin-top/right/
   * bottom/left -> margin) so the output stays short without changing what it
   * does. Falls back to the longhands if anything would be lost.
   */
  function compressDecls(map) {
    const props = Object.keys(map);
    if (props.length < 2) return map;
    const s = scratch();
    try { s.cssText = serializeDecls(map); } catch { return map; }
    if (!s.cssText) return map;
    const out = {};
    for (const decl of splitTop(s.cssText, ';')) {
      const i = decl.indexOf(':');
      if (i < 0) continue;
      const k = decl.slice(0, i).trim();
      let v = decl.slice(i + 1).trim(), p = '';
      if (/!\s*important$/i.test(v)) { v = v.replace(/!\s*important$/i, '').trim(); p = 'important'; }
      out[k] = [v, p];
    }
    if (!Object.keys(out).length) return map;
    // Nothing may be dropped, and priorities must survive.
    const check = scratch();
    try { check.cssText = serializeDecls(out); } catch { return map; }
    for (const p of props) {
      if (check.getPropertyValue(p) === '' && map[p][0] !== '') return map;
      if ((check.getPropertyPriority(p) === 'important') !== (map[p][1] === 'important')) return map;
    }
    return out;
  }

  /* ============================== paths ============================== */

  const okIdent = (s) => /^-?[A-Za-z_][\w-]*$/.test(s);
  const unique = (root, sel, el) => {
    try {
      const l = root.querySelectorAll(sel);
      return l.length === 1 && l[0] === el;
    } catch { return false; }
  };

  /** Do several children of `parent` match this compound selector? */
  const ambiguous = (parent, compound) => {
    try { return parent.querySelectorAll(`:scope > ${compound}`).length > 1; } catch { return true; }
  };

  /** Shortest stable selector for `el` within its own root. */
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
        // Disambiguate against siblings the compound cannot tell apart --
        // classes alone are not enough when siblings share them.
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

  /** Path as an array of segments, one per shadow boundary crossed. */
  function pathTo(el) {
    const segs = [];
    let node = el, root = el.getRootNode();
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
      : `${el.localName}${el.id ? `#${el.id}` : ''}${
          [...el.classList].slice(0, 2).map((c) => `.${c}`).join('')
        }`;

  /* ============================== analysis ============================== */

  function hoverChain(target) {
    const chain = [];
    let el = target;
    while (el && el.nodeType === 1) {
      chain.push(el);
      el = el.parentElement || (el.getRootNode().host ?? null);
    }
    return chain; // target first, root last
  }

  /** Is `el` inside `ancestor`, crossing shadow boundaries? */
  function within(ancestor, el) {
    let cur = el;
    while (cur) {
      if (cur === ancestor) return true;
      cur = cur.parentElement || (cur.getRootNode().host ?? null);
    }
    return false;
  }

  function analyze(target, opts) {
    const warnings = new Set();
    const applyOnly = !!opts.applyOnly;
    const collected = collectRules();
    collected.warnings.forEach((w) => warnings.add(w));

    const active = collected.rules.filter((e) => conditionsActive(e, warnings));
    const hoverRules = active.filter((e) => e.hovers > 0 && e.hoverBranches.length);

    const nothing = () => ({
      target,
      groups: [],
      hoverRoot: null,
      affected: [],
      snippet: null,
      mode: null,
      applyOnly,
      warnings: [...warnings],
    });

    if (!hoverRules.length) return nothing();

    const chain = hoverChain(target);

    // 1. Attribution: probe each chain element on its own.
    const groups = [];
    for (const host of chain) {
      const hits = probeHits([host], hoverRules);
      if (hits.length) groups.push({ host, hits, seenBranches: new Set(hits.map((h) => h.branch)) });
    }
    groups.reverse(); // parent-most first

    // 2. Selectors with more than one :hover need the whole chain hovered at
    //    once -- probing single elements can never satisfy them. Runs over the
    //    full chain, independently of whether step 1 found anything.
    const multiRules = hoverRules.filter((e) => e.hovers > 1);
    let chainWide = false;
    if (multiRules.length) {
      const attributed = new Set(groups.flatMap((g) => [...g.seenBranches]));
      const extra = probeHits(chain, multiRules).filter((h) => !attributed.has(h.branch));
      if (extra.length) {
        chainWide = true;
        let deepest = groups[groups.length - 1];
        if (!deepest) {
          deepest = { host: target, hits: [], seenBranches: new Set() };
          groups.push(deepest);
        }
        deepest.hits.push(...extra);
        warnings.add(
          `${new Set(extra.map((h) => h.branch)).size} selector(s) require more than one element hovered at once (e.g. "${extra[0].branch}"); attributed to ${describe(deepest.host)}.`
        );
      }
    }

    if (!groups.length) return nothing();

    // Elements that must read as hovered. Multi-:hover rules reference elements
    // beyond the contributing set, so those need the whole chain.
    const hosts = chainWide ? chain.slice() : groups.map((g) => g.host);

    // 3. Element-level deltas, resolved against the real cascade.
    const perElement = new Map(); // el -> { el, group, candidates:Set, pseudo:Map }
    for (const g of groups) {
      for (const hit of g.hits) {
        let rec = perElement.get(hit.el);
        if (!rec) {
          rec = { el: hit.el, group: g, candidates: new Set(), pseudoHits: [], hits: [] };
          perElement.set(hit.el, rec);
        }
        rec.hits.push(hit);
        if (hit.pe) rec.pseudoHits.push(hit);
        else for (const p of hit.entry.props) rec.candidates.add(p);
      }
    }

    const records = [...perElement.values()];
    const baseComputed = new Map();
    const hoverComputed = new Map();

    // Both snapshots are taken with transitions frozen, otherwise a hover
    // effect that transitions would still be reading its start value here and
    // would look like "nothing changed".
    const thaw = freezeMotion();
    try {
      for (const rec of records) baseComputed.set(rec.el, snapshot(rec.el, rec.candidates));
      withHoverForced(
        hoverRules,
        hosts,
        () => {
          for (const rec of records) {
            hoverComputed.set(rec.el, snapshot(rec.el, rec.candidates));
            rec.hoverWin = winners(rec.el, rec.candidates, active, true, collected.layerIndex);
          }
        },
        warnings
      );
    } finally {
      thaw();
    }

    const groupOf = (entry, el) =>
      groups.find((g) => g.hits.some((h) => h.entry === entry && h.el === el));

    for (const rec of records) {
      const hoverWin = rec.hoverWin || new Map();
      const baseWin = winners(rec.el, rec.candidates, active, false, collected.layerIndex);
      const hoverCS = hoverComputed.get(rec.el) || {};
      const baseCS = baseComputed.get(rec.el) || {};

      // A property changes if a different declaration wins AND that actually
      // moves the computed value. Iterate both states' winners, because hover
      // can also REMOVE a declaration (`li:not(:hover)`).
      const changed = [];
      for (const prop of new Set([...hoverWin.keys(), ...baseWin.keys()])) {
        const win = hoverWin.get(prop);
        const base = baseWin.get(prop);
        if (win && base && win.declKey === base.declKey) continue;
        if (!NO_COMPUTED_FILTER.test(prop) && baseCS[prop] === hoverCS[prop]) continue;
        changed.push(prop);
      }

      const decls = {};
      const byGroup = new Map();
      const done = new Set();
      for (const prop of changed) {
        if (done.has(prop)) continue;
        const win = hoverWin.get(prop);
        const priority = needsImportant(win) ? 'important' : '';

        if (!win) {
          // Hover removes the declaration that was winning. No rule holds the
          // resulting value, so the resolved one is the only faithful answer.
          done.add(prop);
          const value = hoverCS[prop];
          if (value !== undefined && value !== '') {
            decls[prop] = [value, priority];
            rec.hasRemoval = true;
            warnings.add(
              `Hovering removes a declaration of ${prop} on ${describe(rec.el)} (an inverted rule such as :not(:hover)); it is emitted as the resolved value because no rule holds that value.`
            );
          }
          const bg = groupOf(baseWin.get(prop) && baseWin.get(prop).entry, rec.el) || rec.group;
          byGroup.set(bg, (byGroup.get(bg) || 0) + 1);
          continue;
        }

        const decl = win.decl;
        // Emit the authored shorthand only if this declaration owns every
        // longhand it covers; otherwise another rule wins part of it and the
        // shorthand would clobber that.
        const ownsAll = decl.longhands.every((lh) => (hoverWin.get(lh) || {}).declKey === win.declKey);
        if (ownsAll) {
          decl.longhands.forEach((lh) => done.add(lh));
          decls[decl.name] = [decl.value, priority];
        } else {
          done.add(prop);
          const style = win.entry ? win.entry.rule.style : rec.el.style;
          let value = style.getPropertyValue(prop);
          if (!value) {
            // var()-pending longhand of a partially overridden shorthand: the
            // authored token is unreachable, fall back to the resolved value.
            value = hoverCS[prop] || '';
            warnings.add(
              `"${decl.name}" on ${describe(rec.el)} is partly overridden by another rule, so ${prop} is emitted as its resolved value rather than the authored token.`
            );
          }
          if (value) decls[prop] = [value, priority];
        }
        const g = groupOf(win.entry, rec.el) || rec.group;
        byGroup.set(g, (byGroup.get(g) || 0) + 1);
      }

      rec.decls = compressDecls(decls);
      rec.propCount = Object.keys(rec.decls).length;
      rec.byGroup = byGroup;
      for (const hit of rec.pseudoHits) {
        const g = groupOf(hit.entry, rec.el) || rec.group;
        byGroup.set(g, byGroup.get(g) || 0);
      }
    }

    const affected = records.filter((r) => r.propCount || r.pseudoHits.length);
    for (const g of groups) {
      g.elements = affected.filter((r) => r.byGroup.has(g));
      g.props = g.elements.reduce((n, r) => n + (r.byGroup.get(g) || 0), 0);
      // An ancestor counts too: inherited properties and custom properties set
      // on an ancestor change how the target renders.
      g.touchesTarget = g.elements.some((r) => within(target, r.el) || within(r.el, target));
    }

    const effective = groups.filter((g) => g.elements.length);
    if (!effective.length) return { ...nothing(), matchedButNoEffect: true };

    const hoverRoot = (effective.find((g) => g.touchesTarget) || effective[0]).host;

    const built = codegen(affected, hosts, opts, warnings);
    const result = {
      target,
      hoverRoot,
      groups: effective,
      affected,
      snippet: built.snippet,
      mode: built.mode,
      applyOnly,
      warnings: [...warnings],
      _internals: {
        hoverRules,
        hosts,
        active,
        layerIndex: collected.layerIndex,
        verifySnippet: built.verifySnippet,
      },
    };
    if (opts.verify) result.verification = verify(result);
    return result;
  }

  /**
   * Pin transitions and animations to their end state so getComputedStyle
   * reports a settled value instead of an interpolated one. Returns the undo.
   * Only ever used while measuring -- the emitted snippet leaves motion alone.
   */
  function freezeMotion() {
    const el = document.createElement('style');
    el.textContent = '*,*::before,*::after{transition:none !important;animation:none !important}';
    document.head.appendChild(el);
    return () => el.remove();
  }

  function snapshot(el, props) {
    const cs = getComputedStyle(el);
    const out = {};
    for (const p of props) out[p] = cs.getPropertyValue(p);
    return out;
  }

  /**
   * An inline style beats every author rule except an !important one -- and
   * because `winners()` resolves importance through the cascade, the winning
   * declaration is important whenever any applicable declaration is. So the
   * winner's own flag is all we need to decide whether to emit !important.
   */
  const needsImportant = (win) => !!(win && win.important);

  /* ============================== codegen ============================== */

  function codegen(affected, hosts, opts, warnings) {
    const format = opts.format || 'auto';
    const cssRules = new Map(); // entry -> Set(branch)
    const inlineTargets = [];
    const addCss = (entry, branch) => {
      if (!cssRules.has(entry)) cssRules.set(entry, new Set());
      cssRules.get(entry).add(branch);
    };

    for (const rec of affected) {
      // Pseudo-elements are unreachable via element.style -- always CSS.
      for (const hit of rec.pseudoHits) addCss(hit.entry, hit.branch);
      // Toggling a class can only ADD styling. When hover works by removing a
      // declaration (`li:not(:hover)`), the original rule still applies, so
      // that element has to be overridden inline no matter what mode is asked.
      if (format === 'css' && !rec.hasRemoval) {
        for (const hit of rec.hits) if (!hit.pe) addCss(hit.entry, hit.branch);
        continue;
      }
      if (format === 'css' && rec.hasRemoval) {
        warnings.add(
          `${describe(rec.el)} is styled inline despite format:'css' -- hovering removes a declaration there, which a class swap cannot undo.`
        );
      }
      if (rec.propCount) inlineTargets.push(rec);
    }

    // Big fan-out is shorter as one CSS rule than as N inline targets.
    if (format === 'auto') {
      const byEntry = new Map();
      for (const rec of inlineTargets) {
        for (const hit of rec.hits) {
          if (hit.pe) continue;
          if (!byEntry.has(hit.entry)) byEntry.set(hit.entry, new Set());
          byEntry.get(hit.entry).add(rec);
        }
      }
      for (const [entry, recs] of byEntry) {
        if (recs.size > (opts.maxInlineFanout || 8)) {
          for (const b of entry.hoverBranches) addCss(entry, b);
          for (const rec of recs) rec.viaCss = true;
        }
      }
    }

    const inline = inlineTargets.filter((r) => !r.viaCss);

    // A shadow-scoped rule has to be injected into that shadow root -- a
    // stylesheet in document.head cannot reach inside one. Group by scope.
    const byScope = new Map();
    for (const [entry, branches] of [...cssRules.entries()].sort((a, b) => a[0].order - b[0].order)) {
      const text = wrapConditions(
        entry,
        `${[...branches].map((b) => replaceHover(b, `.${ON_CLASS}`).text).join(',')}{${entry.rule.style.cssText}}`
      );
      byScope.set(entry.scope, (byScope.get(entry.scope) || '') + `\n${text}`);
    }

    const sheets = [...byScope.entries()].map(([scope, text]) => [
      scope === document || !scope.host ? null : pathTo(scope.host),
      `${text}\n`,
    ]);

    if (sheets.length) {
      warnings.add(
        'Stylesheet-mode rules are appended after the originals, so they sit later in source order; a same-specificity non-hover rule that originally came after them could end up overridden. Run with { verify: true } to check.'
      );
    }

    const paths = inline.map((r) => pathTo(r.el));
    if (paths.some((p) => p.some((s) => s.includes(':nth-'))) || hosts.some((h) => pathTo(h).some((s) => s.includes(':nth-')))) {
      warnings.add(
        'Some elements had no id, test attribute or distinguishing class, so the snippet addresses them by position (:nth-of-type). Those paths break if the DOM order changes.'
      );
    }

    const T = inline
      .map((r, i) => `[${JSON.stringify(paths[i])},${JSON.stringify(r.decls)}]`)
      .join(',\n  ');
    const css = sheets.length;
    const H = JSON.stringify(hosts.map(pathTo));
    const SHEETS = JSON.stringify(sheets);
    const RESOLVE = `const d=document,R=p=>{let n=d;for(const s of p){n=(n.shadowRoot||n).querySelector(s);if(!n)return null}return n};\n`;
    const SET = `for(const k in ds)e.style.setProperty(k,ds[k][0],ds[k][1])`;

    // Toggle form: applyHover() / clearHover(), able to put the page back.
    const buildToggle = () =>
      `(()=>{${RESOLVE}` +
      `const T=[\n  ${T}\n];\n` +
      (css ? `const H=${H},S=${SHEETS}.map(([p,t])=>{const s=d.createElement('style');s.textContent=t;return[p,s]});\n` : '') +
      // P/C hold each element's raw style/class attribute from before the
      // change, so clearHover restores the attribute byte for byte instead of
      // reconstructing it -- no normalized text or leftover style="" to show up
      // in a DOM snapshot. Reading the attribute also flushes any pending
      // inline-style mutation, without which removeAttribute does not stick.
      `const P=new Map(),C=new Map();let on=0;\n` +
      `const applyHover=()=>{if(on)return;on=1;` +
      (css
        ? `for(const[p,s]of S){const r=p?R(p):null;((r&&r.shadowRoot)||d.head).appendChild(s)}` +
          `for(const p of H){const e=R(p);if(!e)continue;C.set(e,e.getAttribute('class'));e.classList.add('${ON_CLASS}')}`
        : '') +
      `for(const[p,ds]of T){const e=R(p);if(!e)continue;P.set(e,e.getAttribute('style'));` +
      `${SET}}};\n` +
      `const clearHover=()=>{if(!on)return;on=0;` +
      `for(const[e,s]of P){s===null?(e.getAttribute('style'),e.removeAttribute('style')):e.setAttribute('style',s)}P.clear();` +
      (css
        ? `for(const[e,c]of C){c===null?e.removeAttribute('class'):e.setAttribute('class',c)}C.clear();for(const[,s]of S)s.remove();`
        : '') +
      `};\n` +
      `Object.assign(window,{applyHover,clearHover});return{applyHover,clearHover}})()`;

    // Apply-only form: just the statements that force the hover state. No
    // restore bookkeeping, no re-entry guard, no globals -- data literals go
    // straight into the for..of headers. Still an IIFE so nothing leaks and it
    // survives being pasted more than once.
    const buildApplyOnly = () =>
      `(()=>{${RESOLVE}` +
      (css
        ? `for(const[p,t]of ${SHEETS}){const s=d.createElement('style');s.textContent=t;` +
          `const r=p?R(p):null;((r&&r.shadowRoot)||d.head).appendChild(s)}\n` +
          `for(const p of ${H}){const e=R(p);e&&e.classList.add('${ON_CLASS}')}\n`
        : '') +
      (inline.length ? `for(const[p,ds]of [\n  ${T}\n]){const e=R(p);if(!e)continue;${SET}}\n` : '') +
      `})()`;

    const toggle = buildToggle();
    return {
      snippet: opts.applyOnly ? buildApplyOnly() : toggle,
      verifySnippet: toggle, // verification needs a restore path
      mode: css ? (inline.length ? 'inline+css' : 'css') : 'inline',
    };
  }

  /* ============================== verify ============================== */

  /**
   * Compare three states property-by-property: baseline, true hover (rules
   * rewritten in place), and the emitted snippet applied. Also checks that
   * clearHover() leaves no residue.
   */
  function verify(result) {
    const { hoverRules, hosts } = result._internals;
    const els = result.affected.map((r) => r.el);
    const all = (el) => {
      const cs = getComputedStyle(el);
      const out = {};
      for (let i = 0; i < cs.length; i++) out[cs[i]] = cs.getPropertyValue(cs[i]);
      return out;
    };

    // Same reason as in analyze(): an interpolated value would make this check
    // timing-dependent. All four snapshots below are settled end states.
    const thaw = freezeMotion();
    // Watched for attribute residue: a leftover style="" or class="" would show
    // up in any DOM-snapshot-based tooling even though the pixels look right.
    const watched = [...new Set([...els, ...hosts])];
    const attrs = () => watched.map((el) => `${el.getAttribute('style')}|${el.getAttribute('class')}`);
    const attrsBefore = attrs();

    const baseline = els.map(all);
    const truth = [];
    withHoverForced(hoverRules, hosts, () => els.forEach((el) => truth.push(all(el))));

    const prev = [window.applyHover, window.clearHover];
    let api;
    const diffs = [];
    try {
      // Always the toggle form: verification needs a restore path to check
      // residue against. It shares the identical apply statements with the
      // apply-only form, so the hover state it proves is the same one.
      api = new Function(`return ${result._internals.verifySnippet}`)();
      api.applyHover();
      const sim = els.map(all);
      api.clearHover();
      const after = els.map(all);
      els.forEach((el, i) => {
        for (const p in truth[i]) {
          if (truth[i][p] !== sim[i][p]) {
            diffs.push({ el, prop: p, expected: truth[i][p], got: sim[i][p], kind: 'hover-state' });
          }
        }
        for (const p in baseline[i]) {
          if (baseline[i][p] !== after[i][p]) {
            diffs.push({ el, prop: p, expected: baseline[i][p], got: after[i][p], kind: 'residue-after-clear' });
          }
        }
      });
      const attrsAfter = attrs();
      watched.forEach((el, i) => {
        if (attrsBefore[i] !== attrsAfter[i]) {
          diffs.push({
            el,
            prop: 'style/class attribute',
            expected: attrsBefore[i],
            got: attrsAfter[i],
            kind: 'residue-attribute',
          });
        }
      });
    } finally {
      thaw();
      window.applyHover = prev[0];
      window.clearHover = prev[1];
      if (prev[0] === undefined) delete window.applyHover;
      if (prev[1] === undefined) delete window.clearHover;
    }
    const out = { pass: diffs.length === 0, diffs };
    if (result.applyOnly) {
      out.note =
        'Checked against the toggle form, which applies the same declarations; the emitted apply-only snippet has no restore path, so its residue checks do not apply.';
    }
    return out;
  }

  /* ============================== reporting ============================== */

  /**
   * Warnings are the only thing apply-only mode still says out loud, condensed
   * to one line. They include "cross-origin stylesheet unreadable", which means
   * the analysis is incomplete -- staying silent about that to keep the console
   * clean would make a partial answer look like a complete one.
   */
  const warnPointer = (res) => {
    if (res.warnings.length) {
      console.warn(
        `cssHoverToJS: ${res.warnings.length} warning(s) -- re-run without { applyOnly: true } to see them.`
      );
    }
  };

  function report(res) {
    if (!res.groups.length) {
      console.log(
        `%ccssHoverToJS%c ${
          res.matchedButNoEffect
            ? 'hover rules match here, but none of them win the cascade -- hovering changes nothing.'
            : 'no hover styling reachable from this element.'
        }`,
        'font-weight:bold',
        ''
      );
      if (res.applyOnly) warnPointer(res);
      else res.warnings.forEach((w) => console.warn(w));
      return;
    }
    // Apply-only: print the snippet and nothing else.
    if (res.applyOnly) {
      console.log(res.snippet);
      warnPointer(res);
      return;
    }
    console.group(`%ccssHoverToJS%c  ${describe(res.target)}`, 'font-weight:bold', '');
    console.log(`hover root: ${describe(res.hoverRoot)}   mode: ${res.mode}`);
    console.table(
      res.groups.map((g, i) => ({
        '#': i + 1,
        'hovered element': describe(g.host),
        elements: g.elements.length,
        properties: g.props,
        'affects target': g.touchesTarget ? 'yes' : 'elsewhere on page',
      }))
    );
    console.groupCollapsed(`changes (${res.affected.length} element${res.affected.length === 1 ? '' : 's'})`);
    for (const rec of res.affected.slice(0, 25)) {
      const props = Object.entries(rec.decls)
        .map(([k, v]) => `${k}: ${v[0]}${v[1] ? ' !important' : ''}`)
        .join('; ');
      const pe = rec.pseudoHits.length
        ? ` + ${[...new Set(rec.pseudoHits.map((h) => h.pe))].join(', ')} (via stylesheet)`
        : '';
      console.log(`%c${describe(rec.el)}%c  ${props}${pe}`, 'color:#08f', '', rec.el);
    }
    if (res.affected.length > 25) console.log(`... and ${res.affected.length - 25} more element(s)`);
    console.groupEnd();
    if (res.warnings.length) {
      console.groupCollapsed(`%c${res.warnings.length} warning(s)`, 'color:#b80');
      res.warnings.forEach((w) => console.warn(w));
      console.groupEnd();
    }
    if (res.verification) {
      const v = res.verification;
      console.log(
        `%cverify: ${v.pass ? 'PASS - simulated state is identical to the real hover state' : `FAIL - ${v.diffs.length} mismatch(es)`}`,
        `color:${v.pass ? '#0a0' : '#c00'};font-weight:bold`
      );
      if (!v.pass) console.table(v.diffs.slice(0, 40).map((d) => ({ element: describe(d.el), ...d, el: undefined })));
    }
    console.log('%csnippet%c (copy/paste anywhere; defines applyHover() / clearHover())', 'font-weight:bold', '');
    console.log(res.snippet);
    console.groupEnd();
  }

  /* ================================ entry ================================ */

  window.cssHoverToJS = function cssHoverToJS(el, opts = {}) {
    const target = el || (typeof $0 !== 'undefined' ? $0 : null);
    if (!target || target.nodeType !== 1) {
      throw new TypeError('cssHoverToJS(element): pass an element, e.g. cssHoverToJS($0)');
    }
    const res = analyze(target, opts);
    if (opts.log !== false) report(res);
    return res;
  };

  window.cssHoverToJS.version = '1.0.0';
})();
