# Element coverage

What the scanner actually sees, measured rather than assumed.

```bash
npm run coverage
```

`docs/coverage-fixture.html` holds one example of every interactive pattern I
could think of; the script crawls it and reports which ones landed in the index.
**31 of 34 handled correctly.** It fails if that drops, so the number can't rot.

The first run of this scored **14/34** — the selector matched only the obvious
tags, and labels came from `innerText` with a couple of fallbacks. Everything
below was invisible until it was measured.

## What it handles

| Group | Cases |
|---|---|
| Anchors | `href`, `role="link"` with no href, `onclick` only |
| Buttons | `<button>`, `div[onclick]`, `div[role=button]`, `[tabindex]`, disabled |
| Icon-only | `aria-label`, nested `<svg><title>`, nested `<img alt>` |
| Indirect labels | `aria-labelledby`, `<label for>`, wrapping `<label>` |
| Form controls | inputs, `<select>` and its `<option>`s, textarea, submit |
| ARIA roles | menuitem, tab, option, combobox, slider, switch, treeitem, and the rest |
| Containment | open shadow DOM (recursive), `contenteditable` |
| Excluded | `aria-hidden="true"` and `[inert]` subtrees |

Two of those deserve a note.

**Icon-only buttons** were the single biggest loss. A control whose only name is
an `<svg><title>` produced an empty string, and an element with no name is
dropped from the index entirely — so on an icon-heavy UI a large share of the
navigation simply did not exist as far as the tool was concerned.

**Shadow DOM** is the other. `querySelectorAll` does not cross a shadow
boundary, so any site built on web components — most modern design systems —
indexed as a near-empty page. The scanner now walks open roots recursively.
Closed roots remain unreachable by anyone, including us.

## Known gaps

**Hover-only menus with a non-semantic trigger.** The crawler hovers the
controls it decides are disclosures, but a trigger that is a bare `<div>` with
no `role`, `tabindex`, `aria-haspopup` or handler gives nothing to detect. A
human knows it is a menu because it opens on hover. Detecting it would mean
hovering every element on the page and diffing the DOM each time — affordable on
a small site, not on a large one. Amazon's mega-nav is this shape.

**Iframes.** Invisible to both halves, and not symmetric: the crawler *could*
walk same-origin frames via Playwright, but the widget cannot highlight inside a
cross-origin frame at all — the browser forbids it. Worth doing for same-origin
embeds; impossible for third-party checkout and payment widgets.

**Canvas and WebGL.** No DOM, nothing to find. Out of scope rather than unfixed.

## Things measured but not gaps

*Disabled controls are indexed.* They are real, and "it's there but greyed out"
is a legitimate answer — but the widget will currently spotlight a control the
visitor cannot click. It should say so instead; `scan.js` exports `isDisabled`
for that and nothing consumes it yet.

*`<option>` elements are indexed.* They are findable but not reliably clickable
through a native select popup. The step resolves; the click may not land.
