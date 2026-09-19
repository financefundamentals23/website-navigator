/* Shared DOM scanning, used by BOTH the crawler and the widget.
 * These two must agree on what an interactive element is and what it is called:
 * the crawler writes labels into the index and the widget matches them against
 * the live page, so any drift silently breaks the match. They used to be two
 * copies and drifted exactly that way. The server concatenates this ahead of
 * nav.js; the crawler injects it into the page. */
(() => {
  const SEL = [
    "a", "button", "summary", "select", "textarea", "option",
    'input:not([type="hidden"])',
    '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]', '[role="tab"]', '[role="switch"]', '[role="checkbox"]',
    '[role="radio"]', '[role="option"]', '[role="combobox"]', '[role="listbox"]',
    '[role="slider"]', '[role="spinbutton"]', '[role="searchbox"]', '[role="textbox"]',
    '[role="treeitem"]',
    "[onclick]",
    '[tabindex]:not([tabindex="-1"])',
    '[contenteditable="true"]',
  ].join(", ");

  const txt = (s) => (s || "").replace(/\s+/g, " ").trim().slice(0, 60);

  /* Roughly the accessible name, in the order the platform computes it. Icon-only
   * buttons are the reason this is more than `innerText`: a control whose only
   * name is an <svg><title> or an <img alt> produced an empty string before, and
   * an element with no name is dropped from the index entirely. */
  function nameOf(el) {
    const by = el.getAttribute?.("aria-labelledby");
    if (by) {
      const parts = by
        .split(/\s+/)
        .map((id) => el.ownerDocument.getElementById(id)?.innerText)
        .filter(Boolean);
      if (parts.length) return txt(parts.join(" "));
    }
    const aria = el.getAttribute?.("aria-label");
    if (aria) return txt(aria);

    // Form controls are usually named by a <label>, not by anything on themselves.
    if (/^(input|select|textarea)$/i.test(el.tagName)) {
      const lbl =
        (el.id && el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`)) ||
        el.closest?.("label");
      if (lbl) {
        const clone = lbl.cloneNode(true);
        clone.querySelectorAll?.("input, select, textarea").forEach((n) => n.remove());
        const t = txt(clone.innerText || clone.textContent);
        if (t) return t;
      }
    }

    return (
      txt(el.getAttribute?.("title")) ||
      txt(el.placeholder) ||
      txt(el.innerText) ||
      txt(el.querySelector?.("img[alt]")?.getAttribute("alt")) ||
      txt(el.querySelector?.("svg title")?.textContent) ||
      txt(el.getAttribute?.("alt")) ||
      txt(el.value) ||
      ""
    );
  }

  function isVisible(el) {
    // Hidden from assistive tech means hidden from us: highlighting a decorative
    // control the user cannot perceive is worse than admitting we found nothing.
    if (el.closest?.('[aria-hidden="true"]') || el.closest?.("[inert]")) return false;
    if (el.tagName === "OPTION") return true; // no box of its own, still selectable
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
  }

  /* Walks open shadow roots. Any site built on web components -- most modern
   * design systems -- is otherwise completely invisible to querySelectorAll. */
  function all(root = document, out = []) {
    for (const el of root.querySelectorAll(SEL)) out.push(el);
    for (const el of root.querySelectorAll("*")) if (el.shadowRoot) all(el.shadowRoot, out);
    return out;
  }

  const roleOf = (el) => el.getAttribute?.("role") || el.tagName.toLowerCase();

  const isDisabled = (el) =>
    el.disabled === true || el.getAttribute?.("aria-disabled") === "true";

  window.__wnavScan = { SEL, nameOf, isVisible, all, roleOf, isDisabled, txt };
})();
