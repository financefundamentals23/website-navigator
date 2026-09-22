/* Website Navigator widget.
 * One network call per question. Everything after that -- the spotlight, the
 * tooltip, detecting the click, advancing to the next step, surviving a page
 * navigation -- happens here, offline.
 */
(() => {
  /* This runs inside someone else's page. The one rule: never throw into it,
   * never hang it. Anything that goes wrong disables the widget quietly --
   * one console.warn for the site owner, nothing for their visitors or their
   * error monitoring. */

  // CMS snippets and tag managers often include a script twice.
  if (window.__wnavLoaded) return;
  window.__wnavLoaded = true;

  // Only readable while this script is executing; null by DOMContentLoaded.
  const script = document.currentScript;

  const start = () => {
    try {
      init();
    } catch (err) {
      console.warn("[navigator] disabled:", err);
    }
  };
  // In <head>, the body (and any data-trigger element) doesn't exist yet.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }

  function init() {
    const SITE = script?.dataset.site || location.hostname;
    const API = (script?.dataset.api || (script?.src ? new URL(script.src).origin : location.origin)).replace(/\/$/, "");
    const TIMEOUT = Number(script?.dataset.timeout) || 8000;
    const KEY = "wnav:state";

    const S = window.__wnavScan;
    if (!S) throw new Error("scanner missing -- load nav.js from the navigator server");

    // sessionStorage throws outright in some contexts (blocked cookies, some
    // private modes, sandboxed frames). Without it a walkthrough can't survive a
    // page load, which is a fine thing to lose; throwing mid-walkthrough is not.
    const store = {
      get() {
        try {
          return JSON.parse(sessionStorage.getItem(KEY) || "null");
        } catch {
          return null;
        }
      },
      set(v) {
        try {
          sessionStorage.setItem(KEY, JSON.stringify(v));
        } catch {}
      },
      clear() {
        try {
          sessionStorage.removeItem(KEY);
        } catch {}
      },
    };

    const candidates = () =>
      S.all().filter((el) => S.isVisible(el) && !root.contains(el) && !host.contains(el));

    /* Match by what the element says, never by a stored CSS path -- selectors break
     * on the next deploy, visible labels usually don't. */
    const find = (step) => bestMatch(candidates(), step);

    function bestMatch(list, step) {
      const want = step.label.toLowerCase().trim();
      let best = null;
      let bestScore = 0;
      for (const el of list) {
        const have = S.nameOf(el).toLowerCase();
        if (!have) continue;
        let score = 0;
        if (have === want) score = 4;
        else if (have.startsWith(want)) score = 3;
        else if (have.includes(want)) score = 2;
        else if (want.includes(have) && have.length > 2) score = 1;
        if (!score) continue;
        if (step.role && S.roleOf(el) === step.role)
          score += 0.5;
        const area = el.getBoundingClientRect().width * el.getBoundingClientRect().height;
        // Prefer the tightest element that matches: a wrapper inherits its children's
        // text, so without this the spotlight lands on a whole nav bar.
        const ranked = score - Math.min(area / 5e6, 0.4);
        if (ranked > bestScore) {
          bestScore = ranked;
          best = el;
        }
      }
      return best;
    }

    /* The step's element is on this page but hidden: a collapsed menu, a closed
     * <details>, an off-canvas side rail. When the page says which control
     * reveals it -- aria-controls on a button marked aria-expanded="false", or
     * the summary of a closed <details> -- point at that control first. */
    function revealer(step) {
      const hidden = bestMatch(
        S.all().filter((el) => !S.isVisible(el) && !root.contains(el) && !host.contains(el)),
        step,
      );
      if (!hidden) return null;
      const details = hidden.closest("details:not([open])");
      const summary = details?.querySelector(":scope > summary");
      if (summary && S.isVisible(summary)) return summary;
      for (const el of candidates()) {
        if (el.getAttribute("aria-expanded") !== "false") continue;
        const ids = (el.getAttribute("aria-controls") || "").split(/\s+/).filter(Boolean);
        if (ids.some((id) => el.getRootNode().getElementById?.(id)?.contains(hidden))) return el;
      }
      return null;
    }

    // Not the step itself: a link to the page the step is on. A detour.
    function linkTo(step) {
      if (!step.page || step.page === location.pathname) return null;
      return (
        candidates().find(
          (el) => el.tagName === "A" && new URL(el.href, location.href).pathname === step.page,
        ) || null
      );
    }

    /* How long the real element gets to appear before a link to its page is
     * offered instead. Signed-in pages render their fields a beat after load --
     * Firebase has to confirm the session first -- and offering the link at once
     * pointed a visitor at "Finance Calculator" while the field they wanted was
     * about to appear right in front of them. */
    const LINK_AFTER_MS = 2500;

    const digest = () =>
      candidates()
        .slice(0, 200)
        .map((el) => ({
          label: S.nameOf(el).slice(0, 60),
          role: S.roleOf(el),
        }))
        .filter((d) => d.label);

    // ---------- UI ----------

    /* Placement and looks are the host site's call.
     *   data-position  bottom-right (default) | bottom-left | top-right | top-left
     *   data-offset    distance from that corner, any CSS length
     *   data-trigger   CSS selector for YOUR OWN element; the built-in button is
     *                  then never rendered and you place the control wherever you
     *                  like in your own markup
     *   data-label     accessible name for the icon button
     *   data-placeholder  text in the question box
     *   data-title / data-note  the panel's heading, and its what-this-is note
     * Colours and size come from CSS custom properties, which cross the shadow
     * boundary on their own -- set them on :root in your stylesheet and they apply
     * here, no options needed:
     *   --wnav-accent --wnav-bg --wnav-fg --wnav-size --wnav-radius --wnav-z  */
    const conf = {
      position: script?.dataset.position || "bottom-right",
      offset: script?.dataset.offset || "20px",
      trigger: script?.dataset.trigger || "",
      label: script?.dataset.label || "Help - find anything on this page",
      placeholder: script?.dataset.placeholder || "e.g. where is dark mode?",
      title: script?.dataset.title || "Find anything",
      // Says plainly what this is and isn't: a guide to places on the site,
      // not an assistant that answers questions or acts for the visitor.
      note:
        script?.dataset.note ||
        "Shows you where things are on this site. It doesn't answer questions or do anything for you, and as AI it can get things wrong.",
    };
    const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

    const [vert, horiz] = (
      ["bottom-right", "bottom-left", "top-right", "top-left"].includes(conf.position)
        ? conf.position
        : "bottom-right"
    ).split("-");

    const host = document.createElement("div");
    host.id = "wnav-host";
    host.style.cssText =
      "position:fixed;inset:0;z-index:var(--wnav-z,2147483647);pointer-events:none;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; font: 14px/1.45 system-ui, -apple-system, sans-serif; }
        .anchor { position: fixed; ${vert}: ${conf.offset}; ${horiz}: ${conf.offset}; }
        .launch {
          pointer-events: auto; display: grid; place-items: center;
          width: var(--wnav-size, 44px); height: var(--wnav-size, 44px);
          background: var(--wnav-accent, #6a5cff); color: #fff;
          border: 0; border-radius: var(--wnav-radius, 50%);
          cursor: pointer; box-shadow: 0 4px 18px rgba(0,0,0,.28);
          transition: transform .12s;
        }
        .launch:hover { transform: scale(1.06); }
        .launch:focus-visible { outline: 3px solid var(--wnav-accent, #6a5cff); outline-offset: 3px; }
        .launch svg { width: 58%; height: 58%; display: block; }
        /* The accent pair behind the AI look: --wnav-accent (as everywhere) plus
         * --wnav-accent-2, the far end of the gradient. */
        .panel {
          --g: linear-gradient(135deg, var(--wnav-accent, #6a5cff), var(--wnav-accent-2, #c04dff));
          --bg: var(--wnav-bg, #fff);
          position: fixed; ${vert}: ${conf.offset}; ${horiz}: ${conf.offset};
          width: 340px; max-width: calc(100vw - 32px); pointer-events: auto;
          color: var(--wnav-fg, #1b1b1f);
          /* gradient hairline border: fill the padding box, let the border box show the gradient */
          border: 1px solid transparent; border-radius: 16px; padding: 12px 14px 12px;
          background: linear-gradient(var(--bg), var(--bg)) padding-box, var(--g) border-box;
          box-shadow: 0 18px 50px -12px color-mix(in srgb, var(--wnav-accent, #6a5cff) 45%, rgba(0,0,0,.35));
          display: none;
        }
        .panel.open { display: block; animation: rise .18s ease-out; }
        @keyframes rise { from { opacity: 0; transform: translateY(6px); } }
        .head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
        .spark { width: 18px; height: 18px; flex: none; }
        .spark .twinkle { transform-origin: 18.5px 5.5px; animation: twinkle 2.6s ease-in-out infinite; }
        @keyframes twinkle { 50% { opacity: .35; transform: scale(.6); } }
        .title {
          font-weight: 650; letter-spacing: .01em;
          background: var(--g); -webkit-background-clip: text; background-clip: text; color: transparent;
        }
        .badge {
          font-size: 10px; font-weight: 700; letter-spacing: .08em; line-height: 1;
          padding: 3px 6px; border-radius: 999px; color: #fff; background: var(--g);
        }
        input {
          width: 100%; padding: 10px 34px 10px 12px; border: 1px solid #d6d6db;
          border-radius: 10px; outline: none;
        }
        .field { position: relative; display: flex; align-items: center; }
        /* Shares .close's sizing and hover; only placed, and only while there is
           something to clear -- an X over an empty box invites a pointless click. */
        .close.clear {
          position: absolute; right: 5px; width: 24px; height: 24px;
          margin-left: 0; display: none;
        }
        .close.clear.on { display: grid; }
        .note {
          display: flex; gap: 7px; align-items: flex-start;
          margin: 10px -4px 0; padding: 8px 10px; border-radius: 10px;
          font-size: 12px; line-height: 1.4; color: #55555f;
          background: color-mix(in srgb, var(--wnav-accent, #6a5cff) 8%, transparent);
        }
        .note svg { width: 14px; height: 14px; flex: none; margin-top: 1px; color: var(--wnav-accent, #6a5cff); }
        .close {
          flex: none; margin-left: auto; width: 28px; height: 28px; display: grid; place-items: center;
          background: none; border: 0; border-radius: 8px; color: inherit;
          opacity: .6; cursor: pointer;
        }
        .close:hover { opacity: 1; background: rgba(127,127,127,.15); }
        .close:focus-visible { opacity: 1; outline: 2px solid var(--wnav-accent, #6a5cff); }
        .close svg { width: 14px; height: 14px; display: block; }
        input:focus { border-color: var(--wnav-accent, #6a5cff); }
        .msg { margin-top: 10px; color: #55555f; }
        .msg:empty { display: none; }
        .ring {
          position: fixed; border-radius: 10px; pointer-events: none; display: none;
          box-shadow: 0 0 0 3px var(--wnav-accent, #6a5cff), 0 0 0 9999px rgba(12,12,20,.55);
          transition: top .16s, left .16s, width .16s, height .16s;
        }
        .ring.on { display: block; }
        .tip {
          position: fixed; max-width: 260px; pointer-events: auto; display: none;
          background: var(--wnav-accent, #6a5cff); color: #fff; padding: 9px 12px; border-radius: 9px;
          box-shadow: 0 6px 20px rgba(0,0,0,.3);
        }
        .tip.on { display: block; }
        .tip b { display: block; font-size: 11px; opacity: .8; font-weight: 600; }
        .tip button {
          margin-top: 7px; background: rgba(255,255,255,.2); color: #fff;
          border: 0; border-radius: 6px; padding: 4px 9px; cursor: pointer;
        }
        @media (prefers-color-scheme: dark) {
          .panel { --bg: var(--wnav-bg, #26262c); color: var(--wnav-fg, #f2f2f5); }
          .note { color: #b4b4c2; }
          input { background: #1b1b1f; color: #f2f2f5; border-color: #3a3a44; }
          .msg { color: #a9a9b6; }
        }
        @media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
      </style>
      <div class="anchor">
        <button class="launch" part="launch" aria-label="${esc(conf.label)}" title="${esc(conf.label)}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
               stroke-linecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9.2"/>
            <path d="M9.3 9.2a2.8 2.8 0 1 1 3.4 3.1v1.4"/>
            <path d="M12.6 17.2h.01"/>
          </svg>
        </button>
      </div>
      <div class="panel" role="dialog" aria-label="${esc(conf.label)}">
        <div class="head">
          <svg class="spark" viewBox="0 0 24 24" aria-hidden="true">
            <defs>
              <linearGradient id="wnavg" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" style="stop-color: var(--wnav-accent, #6a5cff)"/>
                <stop offset="1" style="stop-color: var(--wnav-accent-2, #c04dff)"/>
              </linearGradient>
            </defs>
            <path fill="url(#wnavg)" d="M10 3.5l1.9 5.6 5.6 1.9-5.6 1.9L10 18.5l-1.9-5.6L2.5 11l5.6-1.9z"/>
            <path class="twinkle" fill="url(#wnavg)" d="M18.5 2.5l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9z"/>
          </svg>
          <span class="title">${esc(conf.title)}</span>
          <span class="badge">AI</span>
          <button class="close" type="button" aria-label="Close">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"
                 stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>
          </button>
        </div>
        <div class="field">
          <input aria-label="What are you looking for?" placeholder="${esc(conf.placeholder)}" />
          <button class="close clear" type="button" aria-label="Clear">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"
                 stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>
          </button>
        </div>
        <div class="msg" role="status" aria-live="polite"></div>
        <p class="note">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
            <circle cx="8" cy="8" r="6.5"/><path d="M8 7.2v4M8 4.8h.01" stroke-linecap="round"/>
          </svg>
          <span>${esc(conf.note)}</span>
        </p>
      </div>
      <div class="ring"></div>
      <div class="tip"><b></b><span></span><br><button>Stop</button></div>`;
    document.documentElement.appendChild(host);

    const $ = (s) => root.querySelector(s);
    const anchor = $(".anchor"),
      launch = $(".launch"),
      panel = $(".panel"),
      input = $("input"),
      msg = $(".msg"),
      ring = $(".ring"),
      tip = $(".tip");

    /* Bring your own trigger: point data-trigger at an element in your own markup
     * and ours never appears, so the control sits exactly where your design wants
     * it. Anything else is still the floating icon. */
    let custom = null;
    try {
      custom = conf.trigger ? document.querySelector(conf.trigger) : null;
    } catch {
      console.warn(`[navigator] data-trigger \`${conf.trigger}\` is not a valid selector`);
    }
    if (conf.trigger && !custom) {
      console.warn(`[navigator] data-trigger "${conf.trigger}" matched nothing; using the built-in button`);
    }
    if (custom) anchor.remove();

    const open = () => {
      panel.classList.add("open");
      showLauncher(false);
      input.focus();
    };
    function close() {
      panel.classList.remove("open");
      showLauncher(true);
      // Hand focus back to whatever opened the panel, so keyboard users aren't
      // dropped at the top of the page.
      (custom || launch).focus?.();
    }
    // With a custom trigger the element belongs to the site, so leave it alone.
    function showLauncher(visible) {
      if (custom) return;
      anchor.style.display = visible ? "" : "none";
    }

    launch.onclick = open;
    $(".close:not(.clear)").onclick = close;

    const clear = $(".clear");
    const showClear = () => clear.classList.toggle("on", input.value !== "");
    input.addEventListener("input", showClear);
    clear.onclick = () => {
      input.value = "";
      showClear();
      input.focus();
    };
    custom?.addEventListener("click", (e) => {
      e.preventDefault();
      open();
    });
    $(".tip button").onclick = () => stop();

    // ---------- guiding ----------

    let steps = [],
      at = 0,
      query = "",
      target = null,
      detour = null, // "link" or "reveal" when the target is on the way to the step, not the step
      poll = null,
      recovered = false;

    const save = () =>
      store.set({ steps, at, query, recovered });

    function stop() {
      steps = [];
      target = null;
      clearInterval(poll);
      ring.classList.remove("on");
      tip.classList.remove("on");
      store.clear();
      showLauncher(true);
    }

    function place() {
      if (!target) return;
      /* The element went away: a menu that unmounts its items when it closes, a
       * panel that re-rendered. Holding the ring at its last coordinates leaves
       * it over whatever now sits there -- on the real site, a calculator card --
       * still captioned with the step's hint. Drop it and look again: usually the
       * menu's own button is found next, and the visitor is told to open it. */
      if (!document.contains(target) || !S.isVisible(target)) {
        target = null;
        ring.classList.remove("on");
        tip.classList.remove("on");
        if (steps.length && at < steps.length) awaitStep();
        return;
      }
      const r = target.getBoundingClientRect();
      const pad = 6;
      ring.style.top = r.top - pad + "px";
      ring.style.left = r.left - pad + "px";
      ring.style.width = r.width + pad * 2 + "px";
      ring.style.height = r.height + pad * 2 + "px";
      const below = r.bottom + 14;
      tip.style.top = (below + 110 > innerHeight ? r.top - 110 : below) + "px";
      tip.style.left = Math.min(Math.max(8, r.left - pad), innerWidth - 280) + "px";
    }

    // One rAF loop keeps the ring glued to the target through scrolling, resizing,
    // and any animation the site runs. Cheaper than listening for all three.
    (function track() {
      try {
        place();
      } catch {}
      requestAnimationFrame(track);
    })();

    function show(step, el, kind = null) {
      target = el;
      detour = kind;
      place(); // before revealing, or it flashes at the previous step's position
      ring.classList.add("on");
      tip.classList.add("on");
      tip.querySelector("b").textContent = `Step ${at + 1} of ${steps.length}`;
      // Say so when it's a detour; the step's own hint over a nav link reads as
      // "the thing you want is here", which it isn't.
      tip.querySelector("span").textContent =
        kind === "link"
          ? `Go here first -- "${step.label}" is on that page.`
          : kind === "reveal"
            ? `Open this first -- "${step.label}" is inside.`
            : step.hint || `Click "${step.label}"`;
      target.scrollIntoView({ block: "center", behavior: "smooth" });
    }

    /* The target often doesn't exist yet -- a menu is still animating open, or the
     * SPA hasn't rendered the next screen. Poll instead of guessing a delay. */
    function awaitStep() {
      clearInterval(poll);
      if (at >= steps.length) {
        ring.classList.remove("on");
        tip.classList.remove("on");
        msg.textContent = "You're there.";
        panel.classList.add("open");
        showLauncher(false);
        store.clear();
        return;
      }
      save();
      const step = steps[at];
      const t0 = Date.now();
      target = null;
      detour = null;

      // The real element always wins, even after a detour has been offered.
      const tick = () => {
        const el = find(step);
        if (el) {
          show(step, el);
          return true;
        }
        // Hidden right here, behind a control that says it reveals it: no need
        // to wait -- the page has told us exactly what to open.
        const opener = revealer(step);
        if (opener) {
          if (target !== opener) show(step, opener, "reveal");
          return false;
        }
        if (detour !== "link" && Date.now() - t0 > LINK_AFTER_MS) {
          const link = linkTo(step);
          if (link) show(step, link, "link");
        }
        return false;
      };
      if (tick()) return;

      poll = setInterval(() => {
        if (tick()) return clearInterval(poll);
        // With a detour on offer the visitor has a way forward, so keep watching
        // for the real thing. With nothing, give up after a while and re-ask.
        if (!detour && Date.now() - t0 > 6000) {
          clearInterval(poll);
          recover(step);
        }
      }, 200);
    }

    /* The index was built from a crawl; the live site may have moved on. One retry
     * with what's actually on screen, then we admit defeat rather than loop. */
    async function recover(step) {
      if (recovered) {
        ring.classList.remove("on");
        tip.classList.remove("on");
        panel.classList.add("open");
        showLauncher(false);
        msg.textContent = `Couldn't find "${step.label}" on this page.`;
        return;
      }
      recovered = true;
      msg.textContent = "Rechecking…";
      await ask(query, true);
    }

    document.addEventListener(
      "click",
      (e) => {
        // Runs on every click on the host page, so it must never throw into it.
        try {
          if (!target || !steps.length) return;
          const hit = e.target === target || target.contains(e.target) || e.target.contains(target);
          if (!hit) return;
          // A detour (a link to the step's page, or the menu hiding it) leads to
          // the step; it isn't the step.
          if (!detour) at++;
          target = null;
          ring.classList.remove("on");
          tip.classList.remove("on");
          save();
          setTimeout(awaitStep, 150);
        } catch (err) {
          console.warn("[navigator]", err);
        }
      },
      true,
    );

    async function ask(q, noCache = false) {
      query = q;
      msg.textContent = "Looking…";
      try {
        const r = await fetch(`${API}/guide`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          // Model calls take 1-2s; 8s means the server is in trouble. (Optional
          // call: old browsers without AbortSignal.timeout simply don't time out.)
          signal: AbortSignal.timeout?.(TIMEOUT),
          body: JSON.stringify({
            site: SITE,
            query: q,
            url: location.pathname,
            digest: digest(),
            noCache,
          }),
        });
        const data = await r.json();
        if (r.status === 429) {
          // A limit, not a failure: say so plainly, and say when to try again.
          panel.classList.add("open");
          showLauncher(false);
          const s = data.retryAfter;
          msg.textContent = `Too many questions just now — try again in ${s} second${s === 1 ? "" : "s"}.`;
          return;
        }
        if (data.error) throw new Error(data.error);
        msg.textContent = data.answer || "";
        steps = data.steps || [];
        at = 0;
        if (!steps.length) return;
        panel.classList.remove("open");
        showLauncher(true);
        awaitStep();
      } catch (err) {
        panel.classList.add("open");
        showLauncher(false);
        msg.textContent = "Sorry — couldn't work that out. Try again in a moment.";
        console.warn("[navigator]", err);
      }
    }

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && input.value.trim()) {
        recovered = false;
        ask(input.value.trim());
      }
      if (e.key === "Escape") close();
    });

    // A step can point at another page. Pick the walkthrough back up after the load.
    const saved = store.get();
    if (saved?.steps?.length && saved.at < saved.steps.length) {
      ({ steps, at, query, recovered } = saved);
      showLauncher(false);
      awaitStep();
    }

    window.navigator_widget = { ask, stop, open, close };
  }
})();
