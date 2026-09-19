/* Website Navigator widget.
 * One network call per question. Everything after that -- the spotlight, the
 * tooltip, detecting the click, advancing to the next step, surviving a page
 * navigation -- happens here, offline.
 */
(() => {
  const script = document.currentScript;
  const SITE = script?.dataset.site || location.hostname;
  const API = (script?.dataset.api || new URL(script.src).origin).replace(/\/$/, "");
  const KEY = "wnav:state";

  const SEL =
    'a[href], button, summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="switch"], [role="checkbox"], input:not([type="hidden"]), select, textarea';

  // ---------- finding things on the page ----------

  const nameOf = (el) =>
    (
      el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      el.placeholder ||
      el.innerText ||
      el.getAttribute("alt") ||
      el.value ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim();

  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
  };

  const candidates = () =>
    Array.from(document.querySelectorAll(SEL)).filter(
      (el) => isVisible(el) && !root.contains(el),
    );

  /* Match by what the element says, never by a stored CSS path -- selectors break
   * on the next deploy, visible labels usually don't. */
  function resolve(step) {
    const want = step.label.toLowerCase().trim();
    let best = null;
    let bestScore = 0;
    for (const el of candidates()) {
      const have = nameOf(el).toLowerCase();
      if (!have) continue;
      let score = 0;
      if (have === want) score = 4;
      else if (have.startsWith(want)) score = 3;
      else if (have.includes(want)) score = 2;
      else if (want.includes(have) && have.length > 2) score = 1;
      if (!score) continue;
      if (step.role && (el.getAttribute("role") || el.tagName.toLowerCase()) === step.role)
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
    if (best) return best;

    // Target lives on another page: highlight whatever link goes there.
    if (step.page && step.page !== location.pathname) {
      return (
        candidates().find(
          (el) => el.tagName === "A" && new URL(el.href, location.href).pathname === step.page,
        ) || null
      );
    }
    return null;
  }

  const digest = () =>
    candidates()
      .slice(0, 200)
      .map((el) => ({
        label: nameOf(el).slice(0, 60),
        role: el.getAttribute("role") || el.tagName.toLowerCase(),
      }))
      .filter((d) => d.label);

  // ---------- UI ----------

  const host = document.createElement("div");
  host.id = "wnav-host";
  host.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font: 14px/1.45 system-ui, -apple-system, sans-serif; }
      .launch {
        position: fixed; right: 20px; bottom: 20px; pointer-events: auto;
        background: #1b1b1f; color: #fff; border: 0; border-radius: 999px;
        padding: 11px 18px; cursor: pointer; box-shadow: 0 6px 24px rgba(0,0,0,.28);
      }
      .panel {
        position: fixed; right: 20px; bottom: 20px; width: 320px; pointer-events: auto;
        background: #fff; color: #1b1b1f; border-radius: 14px; padding: 14px;
        box-shadow: 0 10px 40px rgba(0,0,0,.3); display: none;
      }
      .panel.open { display: block; }
      input {
        width: 100%; padding: 10px 12px; border: 1px solid #d6d6db;
        border-radius: 9px; outline: none;
      }
      input:focus { border-color: #6a5cff; }
      .msg { margin-top: 10px; color: #55555f; min-height: 18px; }
      .ring {
        position: fixed; border-radius: 10px; pointer-events: none; display: none;
        box-shadow: 0 0 0 3px #6a5cff, 0 0 0 9999px rgba(12,12,20,.55);
        transition: top .16s, left .16s, width .16s, height .16s;
      }
      .ring.on { display: block; }
      .tip {
        position: fixed; max-width: 260px; pointer-events: auto; display: none;
        background: #6a5cff; color: #fff; padding: 9px 12px; border-radius: 9px;
        box-shadow: 0 6px 20px rgba(0,0,0,.3);
      }
      .tip.on { display: block; }
      .tip b { display: block; font-size: 11px; opacity: .8; font-weight: 600; }
      .tip button {
        margin-top: 7px; background: rgba(255,255,255,.2); color: #fff;
        border: 0; border-radius: 6px; padding: 4px 9px; cursor: pointer;
      }
      @media (prefers-color-scheme: dark) {
        .panel { background: #26262c; color: #f2f2f5; }
        input { background: #1b1b1f; color: #f2f2f5; border-color: #3a3a44; }
        .msg { color: #a9a9b6; }
      }
    </style>
    <button class="launch" part="launch">Find anything</button>
    <div class="panel">
      <input placeholder="e.g. where is dark mode?" />
      <div class="msg"></div>
    </div>
    <div class="ring"></div>
    <div class="tip"><b></b><span></span><br><button>Stop</button></div>`;
  document.documentElement.appendChild(host);

  const $ = (s) => root.querySelector(s);
  const launch = $(".launch"),
    panel = $(".panel"),
    input = $("input"),
    msg = $(".msg"),
    ring = $(".ring"),
    tip = $(".tip");

  launch.onclick = () => {
    panel.classList.add("open");
    launch.style.display = "none";
    input.focus();
  };
  $(".tip button").onclick = () => stop();

  // ---------- guiding ----------

  let steps = [],
    at = 0,
    query = "",
    target = null,
    poll = null,
    recovered = false;

  const save = () =>
    sessionStorage.setItem(KEY, JSON.stringify({ steps, at, query, recovered }));

  function stop() {
    steps = [];
    target = null;
    clearInterval(poll);
    ring.classList.remove("on");
    tip.classList.remove("on");
    sessionStorage.removeItem(KEY);
    launch.style.display = "";
  }

  function place() {
    if (!target || !document.contains(target)) return;
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
    place();
    requestAnimationFrame(track);
  })();

  function show(step) {
    target = resolve(step);
    if (!target) return false;
    place(); // before revealing, or it flashes at the previous step's position
    ring.classList.add("on");
    tip.classList.add("on");
    tip.querySelector("b").textContent = `Step ${at + 1} of ${steps.length}`;
    tip.querySelector("span").textContent = step.hint || `Click "${step.label}"`;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    return true;
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
      launch.style.display = "none";
      sessionStorage.removeItem(KEY);
      return;
    }
    save();
    const step = steps[at];
    if (show(step)) return;

    const until = Date.now() + 6000;
    poll = setInterval(() => {
      if (show(step)) return clearInterval(poll);
      if (Date.now() > until) {
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
      launch.style.display = "none";
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
      if (!target || !steps.length) return;
      const hit = e.target === target || target.contains(e.target) || e.target.contains(target);
      if (!hit) return;
      at++;
      target = null;
      ring.classList.remove("on");
      tip.classList.remove("on");
      save();
      setTimeout(awaitStep, 150);
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
        body: JSON.stringify({
          site: SITE,
          query: q,
          url: location.pathname,
          digest: digest(),
          noCache,
        }),
      });
      const data = await r.json();
      if (data.error) throw new Error(data.error);
      msg.textContent = data.answer || "";
      steps = data.steps || [];
      at = 0;
      if (!steps.length) return;
      panel.classList.remove("open");
      launch.style.display = "";
      awaitStep();
    } catch (err) {
      msg.textContent = "Sorry — couldn't work that out.";
      console.warn("[navigator]", err);
    }
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && input.value.trim()) {
      recovered = false;
      ask(input.value.trim());
    }
    if (e.key === "Escape") {
      panel.classList.remove("open");
      launch.style.display = "";
    }
  });

  // A step can point at another page. Pick the walkthrough back up after the load.
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY) || "null");
    if (saved?.steps?.length && saved.at < saved.steps.length) {
      ({ steps, at, query, recovered } = saved);
      launch.style.display = "none";
      awaitStep();
    }
  } catch {}

  window.navigator_widget = { ask, stop };
})();
