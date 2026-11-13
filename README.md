# CSS Hover → JavaScript

Point it at an element and it tells you everything CSS would change when that element is
hovered — including changes CSS makes to *other* elements — then prints a standalone
JavaScript snippet that forces that exact state on demand.

Built for the case where a screenshot needs to capture a hover state: `:hover` cannot be
triggered from JavaScript, so the state has to be reconstructed.

## Use

Paste `cssHoverToJavascript.js` into the browser console, select an element in the Elements
panel, then:

```js
cssHoverToJS($0)                       // report + copy-pasteable snippet
cssHoverToJS($0, { verify: true })     // also prove the snippet matches the real hover state
cssHoverToJS($0, { format: 'css' })    // force stylesheet mode instead of auto
cssHoverToJS($0, { applyOnly: true })  // print only the code that applies the hover
cssHoverToJS($0, { log: false })       // no console output, just the return value
```

`$0` must be passed explicitly — it is a console-only binding the script cannot read itself.

The printed snippet has no dependency on the analyzer. Running it defines two functions:

```js
applyHover();   // force the hover state
// ...take the screenshot...
clearHover();   // restore exactly what was there before
```

### `applyOnly: true`

For when you just want the hover replicated. The console prints **only** the statements that
apply it — no report, no table, no verify banner — and the snippet drops everything that exists
to support undoing: the `applyHover`/`clearHover` functions, the `style`/`class` attribute
bookkeeping, the re-entry guard, and the `window` assignment. Measured 363–684 characters
shorter across the fixture cases (the larger saving in stylesheet mode, which has more to drop).

```js
(()=>{const d=document,R=p=>{let n=d;for(const s of p){n=(n.shadowRoot||n).querySelector(s);if(!n)return null}return n};
for(const[p,ds]of [[["#t"],{"color":["var(--brand-600)",""]}],[["span.icon"],{"opacity":["1",""]}]]){const e=R(p);if(!e)continue;for(const k in ds)e.style.setProperty(k,ds[k][0],ds[k][1])}
})()
```

It composes with everything else — `format`, `verify`, `log`, `maxInlineFanout` all still apply.
`verify: true` keeps checking in full (against the toggle form, which applies the same
declarations) and adds a `note` explaining that restore checks don't apply here.

It stays an IIFE rather than bare statements, which costs about twelve characters and buys
re-pastability: bare `const d`/`const R` would throw `already declared` the second time you run
it in the same console.

Two consequences of having no restore path:

- **Nothing is put back.** The inline styles, injected `<style>` and `cssh-on` class stay on the
  page. Use the default toggle form when the page has to return to normal afterwards.
- **Not idempotent in stylesheet mode.** Re-running appends a second identical `<style>`
  element — harmless to rendering, but it accumulates DOM nodes. The toggle form's re-entry
  guard is what prevents that, and apply-only drops it.

Warnings are the one thing still reported, condensed to a single line, because they include
"cross-origin stylesheet unreadable" — which means the analysis is incomplete, and a partial
answer shouldn't look like a complete one. `log: false` suppresses that too.

## How it knows

You cannot force `:hover` from JavaScript, but you can **rewrite** it.

Replacing every `:hover` in a selector with `[data-cssh-probe]` and stamping that attribute on
an element makes `querySelectorAll` return exactly the elements CSS would restyle when that
element is hovered — for any combinator (`>`, `+`, `~`, descendant) and for `:has(:hover)`.
Rewriting `selectorText` **in place** (then restoring it) additionally yields a true
hover-state computed-style snapshot, which is what `verify: true` compares against.

Three consequences worth knowing:

- **Hover propagates up the DOM.** Pointing at an element hovers it *and* every ancestor, so
  the real state is the union of contributions along the whole chain. The parent-most
  contributor is reported as the hover root; changes are grouped per hovered ancestor.
- **Values come from the rules, not from computed styles.** `var(--brand-600)`,
  `calc()`, `clamp()`, custom properties and `!important` survive into the JavaScript, so the
  design tokens and the logic are preserved rather than flattened into resolved values.
  Computed styles are used only to confirm a declaration actually changes something. The values
  are read back through the CSSOM, which canonicalises some of them without changing what they
  mean: `calc(1px + 0.01em)` comes back as `calc(0.01em + 1px)`.
- **Matching both ways.** An element is affected if a rule's match status *changes*, in either
  direction — which catches inverted rules like `li:not(:hover)`, where hovering *removes* a
  declaration.

## What it reads

`document.styleSheets` (recursing through `@media`, `@supports`, `@container`, `@layer` and CSS
nesting), `adoptedStyleSheets`, open shadow roots, and `<style>` anywhere in the document.
Conditions are evaluated for the current viewport; the cascade is resolved properly, including
layer order, importance, specificity, source order and the element's own `style` attribute.

## Output modes

Inline by default — `element.style.setProperty()` with the authored values. It escalates to an
injected stylesheet (rules reproduced verbatim with `:hover` swapped for a class of identical
specificity) only when inline cannot work:

| Escalates when | Why |
| --- | --- |
| the rule targets a pseudo-element (`.btn:hover::after`) | `element.style` cannot reach `::after` |
| one rule hits more than 8 elements | one CSS rule is shorter than N inline targets |

Shadow-scoped rules are injected into their own shadow root, not `document.head`.

`clearHover()` restores each element's raw `style` attribute byte for byte (and removes it
entirely if it was absent), so nothing shows up in a DOM snapshot afterwards. The analyzer
itself also leaves the page untouched: every probe attribute and `selectorText` rewrite is
reverted before it returns.

## Verification

`{ verify: true }` compares computed styles property-by-property across four states: baseline,
true hover (rules rewritten in place), the snippet applied, and after `clearHover()`. It passes
only if the simulated state is identical to the real hover state on every property of every
affected element, with no residue afterwards — including no leftover `style`/`class` attribute
text. Transitions and animations are frozen while measuring so the comparison reads settled
end states instead of interpolated ones; the emitted snippet leaves motion alone.

Shorthands are skipped — their longhands are all compared anyway, and a shorthand's computed
serialisation can differ while every longhand is identical (Chrome writes `text-decoration` as
`underline` for `currentcolor` but `underline rgb(…)` for the same colour stated explicitly).
On a page whose CSP forbids eval, the snippet string cannot be run, so the same data is checked
through the eval-free `cssHoverToJS.toggle(plan)` instead; `verification.checked` says which
(`'snippet'` or `'plan'`). Everything the analyzer injects while measuring is a constructed
stylesheet, which a strict `style-src` CSP does not block.

Run `fixture.html` for the covered cases: descendant subjects, sibling combinators,
pseudo-elements, `:has(:hover)`, cascade layers, CSS nesting, shorthand collapsing, big
fan-out, shadow DOM + `adoptedStyleSheets`, `!important` on both sides, pre-existing style
attributes, two elements hovered at once, inverted `:not(:hover)`, transitions, and hover that
swaps a custom property consumed by descendants.

## Limits, all surfaced as warnings

- **Cross-origin stylesheets are unreadable from page script.** CSSOM denies access, so hover
  rules from a third-party CDN sheet are invisible to `cssHoverToJS` run from the console. The
  sheet is named in a warning rather than silently skipped. Something that *can* fetch it (the
  extension does) passes the text in with `cssHoverToJS.provideSheets({ [href]: cssText })`; the
  rules are then analysed in the original sheet's place. `cssHoverToJS.unreadableSheets()` lists
  what is missing.
- **Closed shadow roots** cannot be inspected at all. They only matter when the host is on the
  hover chain (the target or an ancestor), so that is the only time they are reported. Page
  script cannot tell a closed shadow host from an ordinary element, so on its own the library
  guesses (an empty custom element on the chain); a caller that knows, like the extension, passes
  `closedShadowHosts: [...]`.
- **`@container` conditions** cannot be evaluated from script; those rules are assumed to apply.
- **Stylesheet-mode rules are appended last**, so a same-specificity non-hover rule that
  originally came after them could end up overridden. `verify: true` detects it.
- **Inverted rules** are reported, and reproduced as a resolved value — when hover removes the
  winning declaration, no rule holds the resulting value, so there is no authored form to keep.
- **Position-based paths.** Elements with no id, test attribute or distinguishing class are
  addressed by `:nth-of-type`, which breaks if DOM order changes.
- **Element references are resolved when `applyHover()` runs**, so a re-render between
  generating the snippet and running it can leave it pointing at nothing.

## Chrome extension

The same analyzer, driven from a side panel instead of the console. `cssHoverToJavascript.js` is
unchanged and unaware of the extension — the panel only ever calls its one public global,
`window.cssHoverToJS(element, opts)` — so the file stays a standalone drop-in for other projects.

### Install

The repo root *is* the extension root. `chrome://extensions` → enable **Developer mode** →
**Load unpacked** → select this directory. Then open a page and click the toolbar icon.

```
manifest.json              extension root
cssHoverToJavascript.js    injected verbatim into the page
extension/
  background.js            service worker: injection + message routing
  inject.js                the functions that run inside the page
  picker.js                element picker overlay
  sidepanel.{html,css,js}  the panel
  icons/                   plus make-icons.mjs to regenerate them
```

The library is injected into the page's **main world** the moment the panel opens, so
`cssHoverToJS($0)` also works in that page's own DevTools console — the console workflow above
keeps working with nothing to paste.

### Picking a target

`cssHoverToJS` needs an element, so the panel needs a way to name one.

**Pick element** highlights whatever is under the cursor and, on click, writes a selector into the
input. The hovered node is `event.composedPath()[0]` — the node a real mouse actually hovers,
including inside open shadow roots. Clicks, context menus and keyboard events are swallowed while
picking, so nothing on the page activates; `Esc` cancels.

The selector is built the same way the generated snippets build their own paths — id, then a
test/name attribute, then classes plus `:nth-of-type` — and verified unique at every step. Shadow
boundaries are written `host >>> inner`, one segment per boundary:

```
#nav > li:nth-of-type(3) > a
my-widget#widget >>> span.inner
```

The input is editable and accepts anything `querySelector` does, so typing a selector by hand is
equivalent to picking one. `Matches …` under the field resolves live; **Highlight** flashes a box
over the match. When a selector matches several elements the first is analyzed, and the panel says
so rather than refusing.

### What it decides for you

The panel is opinionated where the library is general. `verify`, `applyOnly`, `format` and `log` are
not exposed, because the extension exists to hand someone a snippet they can trust, not to make them
choose how it is generated:

- **Every snippet is verified** against the real hover state, on every run. The panel says nothing
  when it matches — a clean run is silent. It shows one red line, plus the full mismatch table,
  when it does not.
- **The snippet is always the apply-only form.** The panel's own button covers apply and clear, so
  there is no reason to hand the user the `applyHover`/`clearHover` scaffolding too. It applies the
  hover state and does not undo it, which is exactly what a screenshot needs; reload to reset.
- **`format` is always `auto`**, which already escalates to an injected stylesheet exactly when
  inline cannot work.
- **The full report always goes to the page console**, on every run, inside a collapsed group. It
  is not a setting, because turning it off would throw away the only complete account of what the
  analysis found — see below.

**Warnings live in that console report and nowhere else.** The single exception is CSS the analyzer
could not read at all — an unreadable cross-origin stylesheet, or a closed shadow root — which
raises a *"this snippet may be incomplete"* line in the panel. That one has to be visible, because
always-on verify cannot catch it: the analyzer cannot read those rules, so it cannot rewrite them
for the ground-truth snapshot either, and the comparison passes on an answer that is wrong.

The single **Apply hover** button flips to **Clear hover** once the state is applied. It runs the
result's `plan` — the snippet's data without its code — through `cssHoverToJS.toggle(plan)`, which
does exactly what the toggle snippet does without any eval, so it works on pages whose CSP forbids
eval (GitHub, MDN). A unit test applies both to every fixture case and requires identical DOM and
computed styles. Analyzing again clears the hover first — reading the page with inline styles already
applied would treat them as the base state. Nothing is truncated, either: `report()` caps at 25
elements and 40 verify diffs, and the panel shows all of them.

### Where it cannot help

- **The top frame only.** Elements inside iframes are neither pickable nor analyzable.
- **Restricted pages** — `chrome://`, the Web Store, other extensions — refuse injection entirely.
- **Closed shadow roots** cannot be picked or read. The extension does detect them with
  `chrome.dom.openOrClosedShadowRoot`, and raises the *may be incomplete* line only when one sits
  on the hover chain.
- **A `:nth-of-type` selector goes stale** if the DOM reorders between picking and analyzing.
  Picked selectors (and snippet paths) are anchored to the nearest ancestor id whenever position
  is what makes them unique, so only changes inside that ancestor can retarget them. The live
  `Matches …` count is the tell.

### Cross-origin stylesheets

Before each analysis the service worker asks the library which stylesheets the page cannot read
and fetches them itself, using the extension's host permission. The fetch never sends cookies,
and the response must be served as `text/css` — the browser applied the original only because it
was, and this keeps the extension from becoming a way to pull arbitrary cross-origin text into a
page. A sheet that cannot be fetched still raises the *may be incomplete* line.

## Tests

```sh
npm install
npx playwright install chromium
npm test             # everything
npm run test:unit    # library, inject.js and picker.js in a plain page
npm run test:e2e     # the real extension + side panel, driven like a user
```

- `tests/unit/fixture.spec.mjs` pins every case in `fixture.html`.
- `tests/unit/inject.spec.mjs` runs the `inject.js` functions through `page.evaluate`, which
  serialises them exactly as `executeScript` does. CSP cases go through `inPage()`, because
  `page.evaluate` is exempt from the eval CSP the same way the DevTools console is.
- `tests/unit/picker.spec.mjs` drives `picker.js` with a real mouse, `chrome.runtime` stubbed.
- `tests/unit/realworld.spec.mjs` holds patterns reduced from a live-site sweep.
- `tests/unit/package.spec.mjs` guards the list of files that ship.
- Tests marked `test.fail` are known gaps: they pass while the gap exists and start failing
  once it is fixed, which is the cue to remove the marker.
- The e2e suite loads only the git-tracked runtime files (`manifest.json`,
  `cssHoverToJavascript.js`, `extension/`), not the repo root, so `node_modules/` and `tests/`
  never end up inside the loaded extension. `scripts/runtime-files.mjs` owns that list.

### Packaging and CI

The repo root doubles as the extension root, so never zip the root directly: it would include
`node_modules/`. Instead:

```sh
npm run package      # -> dist/css-hover-to-js-<version>.zip, runtime files only
```

`.github/workflows/test.yml` runs the whole suite (unit and e2e, headless Chromium with the
extension loaded) every time a GitHub release is published, then uploads the packaged zip as a
workflow artifact. It can also be started by hand from the Actions tab.
