/**
 * Side panel UI.
 *
 * The panel never calls chrome.scripting -- every page interaction is a message to
 * the service worker, which owns injection. Results arrive as plain objects, already
 * flattened by extension/inject.js, because the library's own return value holds live
 * DOM nodes and CSSRules and cannot cross a message boundary.
 */

const $ = (id) => document.getElementById(id);

/** Minimal element builder. Text always goes through textContent -- selectors,
 *  CSS values and warnings all come from the page and are never trusted as HTML. */
function h(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'on') for (const [type, fn] of Object.entries(v)) node.addEventListener(type, fn);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) node.append(kid);
  return node;
}

const state = {
  tabId: null,
  url: null,
  version: null,
  result: null,
  applied: false,
  picking: false,
  matches: null,
};

/* -------------------------------- messaging -------------------------------- */

async function send(msg) {
  try {
    const res = await chrome.runtime.sendMessage({ ...msg, tabId: state.tabId });
    return res || { ok: false, error: 'The extension service worker did not respond.' };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

function banner(text, kind = 'bad') {
  const node = $('banner');
  node.textContent = text;
  node.className = `banner ${kind}`;
  node.hidden = !text;
}

const clearBanner = () => banner('');

/* --------------------------------- chrome --------------------------------- */

/** Reflect whether the library is present on the page. */
function setStatus(version) {
  state.version = version || null;
  const badge = $('world');
  if (!version) {
    badge.textContent = 'not injected';
    badge.className = 'badge off';
    badge.title = 'The library is not present on this page.';
  } else {
    badge.textContent = 'ready';
    badge.className = 'badge';
    badge.title = 'window.cssHoverToJS is available in this page’s own DevTools console.';
  }
  $('version').textContent = version ? `v${version}` : '';
  syncButtons();
}

function setPicking(on) {
  state.picking = on;
  $('pick').textContent = on ? 'Cancel pick' : 'Pick element';
  $('pick').setAttribute('aria-pressed', String(on));
}

/** One button, two jobs: it reads Apply hover until the state is on, then Clear hover. */
function setApplied(on) {
  state.applied = on;
  $('live').classList.toggle('applied', on);
  const btn = $('hover-toggle');
  btn.textContent = on ? 'Clear hover' : 'Apply hover';
  btn.setAttribute('aria-pressed', String(on));
  syncButtons();
}

/* ------------------------------ target field ------------------------------ */

let probeTimer;

function scheduleProbe() {
  clearTimeout(probeTimer);
  probeTimer = setTimeout(probe, 200);
}

async function probe() {
  const selector = $('selector').value.trim();
  if (!selector) {
    state.matches = null;
    $('match').textContent = 'Pick an element, or type a selector.';
    $('match').className = 'hint';
    syncButtons();
    return;
  }
  const r = await send({ type: 'probe', selector });
  if (!r.ok) {
    state.matches = 0;
    $('match').textContent = r.error || 'Could not evaluate that selector.';
    $('match').className = 'hint bad';
  } else if (r.count === 0) {
    state.matches = 0;
    $('match').textContent = 'Matches nothing on this page.';
    $('match').className = 'hint bad';
  } else if (r.count === 1) {
    state.matches = 1;
    $('match').textContent = `Matches ${r.desc}`;
    $('match').className = 'hint ok';
  } else {
    // querySelector semantics: the library gets the first match. Say so rather
    // than blocking -- the target is well defined, just possibly not the intended one.
    state.matches = r.count;
    $('match').textContent = `Matches ${r.count} elements — the first (${r.desc}) will be analyzed.`;
    $('match').className = 'hint';
  }
  syncButtons();
}

function syncButtons() {
  const usable = !!state.matches && state.matches > 0;
  $('analyze').disabled = !usable;
  $('flash').disabled = !usable;
  $('hover-toggle').disabled = !(state.result && state.result.plan);
}

/* -------------------------------- rendering -------------------------------- */

function renderEmpty(r) {
  return h(
    'p',
    { class: 'note warn' },
    r.matchedButNoEffect
      ? 'Hover rules match this element, but none of them win the cascade — hovering changes nothing.'
      : 'No hover styling is reachable from this element.'
  );
}

function renderSummary(r) {
  const dl = h('dl', { class: 'summary' });
  const add = (label, value) => dl.append(h('dt', { text: label }), h('dd', { text: value }));
  add('target', r.targetDesc || '—');
  add('hover root', r.hoverRootDesc || '—');
  add('mode', r.mode || '—');
  add('elements', String(r.affected.length));
  return dl;
}

function renderGroups(r) {
  const rows = r.groups.map((g) =>
    h(
      'tr',
      null,
      h('td', { class: 'mono', text: g.hostDesc || '—' }),
      h('td', { class: 'num', text: String(g.elements) }),
      h('td', { class: 'num', text: String(g.props) }),
      h('td', { text: g.touchesTarget ? 'yes' : 'elsewhere' })
    )
  );
  // A disclosure, not a section: on a page with several hover roots this table is
  // detail, and the count in the summary is what most runs actually need.
  return h(
    'details',
    { class: 'fold' },
    h('summary', null, h('h3', { text: `Hovered ancestors (${r.groups.length})` })),
    h(
      'div',
      { class: 'scroll' },
      h(
        'table',
        null,
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', { text: 'hovered element' }),
            h('th', { text: 'els' }),
            h('th', { text: 'props' }),
            h('th', { text: 'affects target' })
          )
        ),
        h('tbody', null, rows)
      )
    )
  );
}

function renderAffected(r) {
  // No truncation. The library's console report() caps at 25 elements; the return
  // value carries the full list, so the panel shows all of it.
  const cards = r.affected.map((rec) => {
    const tags = [
      rec.pseudos.length ? rec.pseudos.join(' ') : null,
      rec.viaCss ? 'via stylesheet' : null,
      rec.hasRemoval ? 'hover removes a rule' : null,
    ].filter(Boolean);
    return h(
      'div',
      { class: 'el' },
      tags.length ? h('span', { class: 'el-tags', text: tags.join(' · ') }) : null,
      h('div', { class: 'el-name', text: rec.desc || '—' }),
      rec.decls.map(([prop, value, important]) =>
        h(
          'div',
          { class: 'decl' },
          h('b', { text: `${prop}:` }),
          h('i', { text: value }),
          important ? h('em', { text: '!important' }) : null
        )
      ),
      rec.decls.length ? null : h('div', { class: 'hint', text: 'pseudo-element only' })
    );
  });
  // Collapsed by default -- ten cards would otherwise push the snippet, the one
  // thing the user came for, off the bottom of the panel.
  return h(
    'details',
    { class: 'fold' },
    h(
      'summary',
      null,
      h('h3', { text: `Changes (${r.affected.length} element${r.affected.length === 1 ? '' : 's'})` })
    ),
    cards
  );
}

/**
 * The panel's entire warning surface: at most two lines, and none at all on a
 * clean run. Everything else the library warns about goes to the page console.
 */
function renderNotices(r) {
  const parts = [];

  // Unreadable CSS is the one thing verify cannot catch -- it is blind to those
  // rules on both sides of the comparison, so it passes on an incomplete answer.
  if (r.incomplete && r.incomplete.length) {
    parts.push(
      h(
        'div',
        { class: 'note warn' },
        h('strong', { text: 'This snippet may be incomplete. ' }),
        h('span', {
          text: 'Some CSS could not be read, so any hover rules it contains are invisible to the analysis.',
        }),
        h('ul', null, r.incomplete.map((w) => h('li', { text: w })))
      )
    );
  }

  const v = r.verification; // present only when verification ran AND failed
  if (v) {
    parts.push(
      h('p', {
        class: 'note fail',
        text: `This snippet does not match the real hover state — ${v.diffs.length} mismatch${
          v.diffs.length === 1 ? '' : 'es'
        }.`,
      }),
      h(
        'details',
        null,
        h('summary', { text: `show all ${v.diffs.length}` }),
        h(
          'div',
          { class: 'scroll' },
          h(
            'table',
            null,
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', { text: 'element' }),
                h('th', { text: 'property' }),
                h('th', { text: 'expected' }),
                h('th', { text: 'got' }),
                h('th', { text: 'kind' })
              )
            ),
            h(
              'tbody',
              null,
              v.diffs.map((d) =>
                h(
                  'tr',
                  null,
                  h('td', { class: 'mono', text: d.desc || '—' }),
                  h('td', { class: 'mono', text: d.prop }),
                  h('td', { class: 'mono', text: d.expected }),
                  h('td', { class: 'mono', text: d.got }),
                  h('td', { text: d.kind })
                )
              )
            )
          )
        )
      )
    );
  }

  return parts.length ? h('section', null, parts) : null;
}

function renderSnippet(r) {
  if (!r.snippet) return null;
  const copy = h('button', {
    class: 'tiny outline',
    text: 'Copy',
    on: {
      async click(e) {
        try {
          await navigator.clipboard.writeText(r.snippet);
          e.target.textContent = 'Copied';
          setTimeout(() => (e.target.textContent = 'Copy'), 1200);
        } catch {
          banner('Clipboard write was blocked. Select the snippet text and copy it manually.', 'warn');
        }
      },
    },
  });
  return h(
    'section',
    null,
    h(
      'div',
      { class: 'row' },
      h('h3', { class: 'grow', text: `Hover snippet — ${r.snippet.length} chars` }),
      copy
    ),
    h('pre', { class: 'snippet', text: r.snippet })
  );
}

function render() {
  const out = $('results');
  out.replaceChildren();
  const r = state.result;
  if (!r) {
    $('live').hidden = true;
    return;
  }
  if (r.empty) {
    out.append(renderEmpty(r), renderNotices(r) || '');
    $('live').hidden = true;
    return;
  }
  out.append(
    renderSummary(r),
    renderGroups(r),
    renderAffected(r),
    renderNotices(r) || '',
    renderSnippet(r) || ''
  );
  $('live').hidden = false;
}

/* --------------------------------- actions --------------------------------- */

async function analyze() {
  const selector = $('selector').value.trim();
  if (!selector) return;
  clearBanner();
  $('analyze').disabled = true;
  $('analyze').textContent = 'Analyzing…';
  try {
    // Reading the page while a hover is applied would treat the applied inline
    // styles as the base state and produce a wrong answer, so undo it first.
    if (state.applied) {
      await send({ type: 'clear' });
      setApplied(false);
    }
    const r = await send({ type: 'analyze', selector });
    if (!r.ok) {
      state.result = null;
      render();
      banner(
        r.restricted ? 'Chrome does not allow extensions to run on this page.' : r.error || 'Analysis failed.'
      );
      return;
    }
    state.result = r;
    if (r.version) setStatus(r.version);
    // A fresh analysis invalidates whatever the previous snippet applied.
    state.applied = false;
    render();
    setApplied(false);
  } finally {
    $('analyze').textContent = 'Analyze';
    syncButtons();
  }
}

async function apply() {
  const plan = state.result && state.result.plan;
  if (!plan) return;
  clearBanner();
  const r = await send({ type: 'apply', plan });
  if (!r.ok) return banner(r.error || 'Could not apply the hover state.');
  setApplied(true);
}

async function clearHover() {
  clearBanner();
  const r = await send({ type: 'clear' });
  if (!r.ok) return banner(r.error || 'Could not clear the hover state.');
  setApplied(false);
}

/* ------------------------------ tab lifecycle ------------------------------ */

async function attach({ keepSelector = false } = {}) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const changed = tab.id !== state.tabId;
  state.tabId = tab.id;
  state.url = tab.url || '';
  $('page-url').textContent = state.url.replace(/^https?:\/\//, '');

  if (changed || !keepSelector) $('selector').value = '';
  state.result = null;
  setApplied(false);
  setPicking(false);
  render();
  clearBanner();

  const r = await send({ type: 'status' });
  if (!r.ok) {
    setStatus(null);
    banner(
      r.restricted
        ? 'Chrome does not allow extensions to run on this page. Open a normal http(s) page.'
        : r.error || 'Could not reach the page.'
    );
    $('analyze').disabled = true;
    return;
  }
  setStatus(r.version);
  probe();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'picked') {
    setPicking(false);
    $('selector').value = msg.selector;
    probe();
  } else if (msg.type === 'pickerCancelled') {
    setPicking(false);
  } else if (msg.type === 'tabChanged') {
    // A navigation in some other background tab is none of our business.
    if (msg.reason === 'navigation' && msg.tabId !== state.tabId) return;
    // A reload keeps the selector (it usually still resolves); switching tabs
    // does not. Either way the previous result and applied state are gone.
    attach({ keepSelector: msg.reason === 'navigation' });
  }
});

/* ----------------------------------- init ----------------------------------- */

$('selector').addEventListener('input', scheduleProbe);
$('selector').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !$('analyze').disabled) analyze();
});

$('pick').addEventListener('click', async () => {
  clearBanner();
  if (state.picking) {
    await send({ type: 'stopPicker' });
    setPicking(false);
    return;
  }
  const r = await send({ type: 'startPicker' });
  if (!r.ok) {
    return banner(
      r.restricted ? 'Chrome does not allow extensions to run on this page.' : r.error || 'Could not start the picker.'
    );
  }
  setPicking(true);
});

$('flash').addEventListener('click', async () => {
  const selector = $('selector').value.trim();
  if (selector) await send({ type: 'flash', selector });
});

$('reinject').addEventListener('click', async () => {
  clearBanner();
  const r = await send({ type: 'reinject' });
  if (!r.ok) return banner(r.error || 'Re-injection failed.');
  state.result = null;
  state.applied = false;
  setStatus(r.version);
  render();
  setApplied(false);
});

$('analyze').addEventListener('click', analyze);
$('hover-toggle').addEventListener('click', () => (state.applied ? clearHover() : apply()));

await attach();
