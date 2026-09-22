/* End-to-end check: crawl a demo site, ask where dark mode is, and drive the
 * real widget in a real browser. Run: npm test  */
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import { crawl } from "./crawl.ts";
import { db, getElements, putElements } from "./db.ts";

const NAV_PORT = 8799;
const SITE_PORT = 8798;
const SITE = "demo";

// Deliberately shaped like a real app: the target is two hops away, behind a
// link and then a collapsed accordion, surrounded by plausible decoys.
const shell = (title: string, body: string) => `<!doctype html><html><head>
<title>${title}</title><style>
 body{font:15px system-ui;margin:0;padding:40px;max-width:720px}
 header{display:flex;gap:18px;align-items:center;margin-bottom:32px}
 a,button{font:inherit} details{margin:10px 0;padding:10px;border:1px solid #ddd;border-radius:8px}
</style></head><body>
<header>
  <a href="/">Acme</a><a href="/pricing">Pricing</a><a href="/docs">Docs</a>
  <a href="/settings" aria-label="Settings">&#9881;</a>
</header>${body}
<script src="http://localhost:${NAV_PORT}/nav.js" data-site="${SITE}" data-api="http://localhost:${NAV_PORT}"></script>
</body></html>`;

const widgetTag = (extra: string) =>
  `<script src="http://localhost:${NAV_PORT}/nav.js" data-site="${SITE}"
     data-api="http://localhost:${NAV_PORT}" ${extra}></script>`;
const hostButton = `<button id="hostBtn" onclick="window.hostClicked=true">Host button</button>`;
// Failure pages point data-api somewhere broken, so they build their own tag.
const failPage = (attrs: string) =>
  `<!doctype html><html><body>${hostButton}
   <script src="http://localhost:${NAV_PORT}/nav.js" data-site="${SITE}" ${attrs}></script>
   </body></html>`;

const pages: Record<string, string> = {
  "/": shell("Acme", `<h1>Acme</h1><button>Start free trial</button><button>Book a demo</button>`),
  "/pricing": shell("Pricing", `<h1>Pricing</h1><button>Choose Pro</button>`),
  "/docs": shell("Docs", `<h1>Docs</h1><a href="/docs/api">API reference</a>`),
  "/docs/api": shell("API", `<h1>API reference</h1>`),
  "/settings": shell(
    "Settings",
    `<h1>Settings</h1>
     <details><summary>Account</summary><button>Change email</button></details>
     <details><summary>Appearance</summary>
       <button role="switch" aria-checked="false">Dark mode</button>
       <button>Compact layout</button>
     </details>
     <details><summary>Billing</summary><button>Update card</button></details>`,
  ),
  // Hostile conditions for check 10. Each has a host-page button so we can prove
  // the page itself still works after the widget has had its problem.
  "/down": failPage(`data-api="http://localhost:8790"`), // nothing listens there
  "/hang": failPage(`data-api="http://localhost:8791" data-timeout="500"`),
  "/nostorage": `<!doctype html><html><head><script>
    Object.defineProperty(window, "sessionStorage", {
      get() { throw new DOMException("denied", "SecurityError"); } });
  </script></head><body><a href="/settings" aria-label="Settings">&#9881;</a>
  ${hostButton}${widgetTag("")}</body></html>`,
  "/twice": `<!doctype html><html><body>${hostButton}${widgetTag("")}${widgetTag("")}</body></html>`,
  // In <head>, before the element data-trigger points at exists.
  "/head": `<!doctype html><html><head>${widgetTag(`data-trigger="#late"`)}</head>
    <body><button id="late">Help</button></body></html>`,
  // Check 12: the field renders a second after load (like a signed-in profile
  // waiting on Firebase), and a link to another page carrying the same label
  // is already on screen.
  "/late": `<!doctype html><html><body><a href="/settings">Settings page</a><div id="slot"></div>
    <script>setTimeout(() => { slot.innerHTML = '<label for="lf">Late field</label><input id="lf">'; }, 1000)</script>
    ${widgetTag("")}</body></html>`,
  // Check 12: the step genuinely lives on another page; only a link leads there.
  "/detour": `<!doctype html><html><body><a href="/settings">Settings page</a>${widgetTag("")}</body></html>`,
  // Check 13: a side rail collapsed by sliding it off-screen (the shape of the
  // real site's calculator menu), with a toggle that declares what it controls.
  "/rail": `<!doctype html><html><body style="margin:0">
    <button id="rt" aria-controls="rail" aria-expanded="false" aria-label="Open calculator menu"
      style="position:fixed;left:12px;top:12px" onclick="
        const open = this.getAttribute('aria-expanded') === 'true';
        this.setAttribute('aria-expanded', String(!open));
        rail.style.transform = open ? 'translateX(-100%)' : 'none';">&rsaquo;</button>
    <nav id="rail" style="position:fixed;left:0;top:60px;width:200px;transform:translateX(-100%)">
      <a href="/calc-a">Affordability Index</a></nav>
    ${widgetTag("")}</body></html>`,
  // Check 16: a menu that unmounts its items when it closes (React-style), the
  // shape of the real site's account menu.
  "/menu": `<!doctype html><html><body style="margin:0">
    <button id="mt" aria-controls="menu" aria-expanded="false" style="position:fixed;right:12px;top:12px"
      onclick="const open = this.getAttribute('aria-expanded') === 'true';
        this.setAttribute('aria-expanded', String(!open));
        menu.innerHTML = open ? '' : '<button id=\\'dm\\' role=\\'menuitem\\'>Dark mode</button>';">Account menu</button>
    <div id="menu" role="menu" style="position:fixed;right:12px;top:60px"></div>
    <div style="position:fixed;right:12px;top:60px;width:150px;height:40px">Future Expense Calculator</div>
    ${widgetTag("")}</body></html>`,
  // Check 18: a menu button that says it is closed but not what it controls --
  // aria-expanded with no aria-controls, the shape of the real account menu.
  "/popup": `<!doctype html><html><body style="margin:0">
    <button id="pt" aria-expanded="false" aria-haspopup="true" style="position:fixed;right:12px;top:12px"
      onclick="const open = this.getAttribute('aria-expanded') === 'true';
        this.setAttribute('aria-expanded', String(!open));
        pop.style.display = open ? 'none' : 'block';">Account menu</button>
    <div id="pop" role="menu" style="display:none;position:fixed;right:12px;top:60px">
      <button role="menuitem">Dark mode</button></div>
    ${widgetTag("")}</body></html>`,
  // A host site that places and styles the trigger itself.
  "/custom": `<!doctype html><html><head><style>:root{--wnav-accent:green}</style></head>
<body><h1>Custom</h1><button id="myHelp">Need a hand?</button>
<script src="http://localhost:${NAV_PORT}/nav.js" data-site="${SITE}"
        data-api="http://localhost:${NAV_PORT}" data-trigger="#myHelp"></script>
</body></html>`,
};

const siteServer = http.createServer((req, res) => {
  const p = new URL(req.url!, "http://x").pathname;
  const html = pages[p];
  if (!html) return res.writeHead(404).end("nope");
  res.writeHead(200, { "content-type": "text/html" }).end(html);
});

const post = async (path: string, body: object) => {
  const r = await fetch(`http://localhost:${NAV_PORT}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json() as any;
};

const ok = (s: string) => console.log(`  \x1b[32mok\x1b[0m ${s}`);

// Lets check 8 give each simulated visitor its own address.
process.env.TRUST_PROXY = "1";
const { server: navServer } = await import("./server.ts");

await new Promise<void>((r) => siteServer.listen(SITE_PORT, r));
await new Promise<void>((r) => navServer.listen(NAV_PORT, r));

try {
  console.log("\n1. crawl");
  const res = await crawl(SITE, `http://localhost:${SITE_PORT}/`);
  assert(res.pages >= 4, `expected to reach every page, got ${res.pages}`);
  const els = getElements(SITE);

  const dark = els.find((e) => /dark mode/i.test(e.label));
  assert(dark, "crawler never found 'Dark mode'");
  assert.equal(dark.page, "/settings");
  // The whole point of the crawler: it opened a closed accordion to find this.
  assert.equal(dark.parent, "Appearance", `expected parent 'Appearance', got '${dark.parent}'`);
  ok(`indexed ${els.length} elements; 'Dark mode' found inside 'Appearance'`);

  console.log("\n2. the element index");
  const idx = await (await fetch(`http://localhost:${NAV_PORT}/elements?site=${SITE}`)).json();
  assert(!idx.error, `index failed: ${idx.error}`);
  const darkRow = idx.elements.find((e: any) => /dark mode/i.test(e.label));
  assert(darkRow, "the index should offer 'Dark mode'");
  assert.equal(darkRow.page, "/settings");
  assert.equal(darkRow.parent, "Appearance", "and remember what has to be opened first");
  ok(`${idx.elements.length} elements served; 'Dark mode' is on ${darkRow.page} inside '${darkRow.parent}'`);

  console.log("\n3. widget in a browser");
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`http://localhost:${SITE_PORT}/`);

  await page.click("#wnav-host .launch");
  await page.fill("#wnav-host input", "dark");
  // The list is the whole interface now: one entry, and it is the right one.
  await page.waitForFunction(
    () => {
      const li = document.querySelector("#wnav-host")!.shadowRoot!.querySelectorAll(".opts li");
      return li.length === 1 && /Dark mode/.test(li[0].textContent!);
    },
    null,
    { timeout: 10000 },
  );
  await page.press("#wnav-host input", "Enter");
  await page.waitForFunction(
    () => document.querySelector("#wnav-host")!.shadowRoot!.querySelector(".ring.on"),
    null,
    { timeout: 10000 },
  );

  // "Dark mode" lives on /settings, so the way there is offered as a detour.
  // The ring must actually sit on the gear, not just exist.
  const gear = (await page.locator('a[aria-label="Settings"]').boundingBox())!;
  const ringBox = await page.evaluate(() => {
    const r = document.querySelector("#wnav-host")!.shadowRoot!.querySelector(".ring") as HTMLElement;
    return { x: parseFloat(r.style.left), y: parseFloat(r.style.top) };
  });
  assert(Math.abs(ringBox.x - gear.x) < 20 && Math.abs(ringBox.y - gear.y) < 20,
    `ring at ${JSON.stringify(ringBox)} is not on the gear at ${JSON.stringify(gear)}`);
  ok("picking it offers the settings link that leads there");

  await page.click('a[aria-label="Settings"]');
  await page.waitForURL("**/settings");
  await page.waitForFunction(
    () => document.querySelector("#wnav-host")!.shadowRoot!.querySelector(".ring.on"),
    null,
    { timeout: 10000 },
  );
  const stepText = await page.evaluate(
    () => document.querySelector("#wnav-host")!.shadowRoot!.querySelector(".tip b")!.textContent,
  );
  assert.equal(stepText, "Step 1 of 2", "following a link is not one of the steps");
  ok(`survived the page navigation and resumed at '${stepText}'`);

  // The real test of the polling logic: "Dark mode" is not in the DOM's visible
  // tree until this click expands the accordion.
  await page.click("summary:text('Appearance')");
  await page.waitForFunction(
    () => {
      const sr = document.querySelector("#wnav-host")!.shadowRoot!;
      return sr.querySelector(".ring.on") && /Step 2/.test(sr.querySelector(".tip b")!.textContent!);
    },
    null,
    { timeout: 10000 },
  );
  const toggle = (await page.locator('button[role="switch"]').boundingBox())!;
  const ring3 = await page.evaluate(() => {
    const r = document.querySelector("#wnav-host")!.shadowRoot!.querySelector(".ring") as HTMLElement;
    return { x: parseFloat(r.style.left), y: parseFloat(r.style.top) };
  });
  assert(Math.abs(ring3.x - toggle.x) < 20 && Math.abs(ring3.y - toggle.y) < 20,
    `ring at ${JSON.stringify(ring3)} is not on the Dark mode toggle at ${JSON.stringify(toggle)}`);
  ok("step 2 waited for the accordion to open, then highlighted the Dark mode toggle");

  await browser.close();

  console.log("\n4. the launcher is the host site's to place and style");
  const b2 = await chromium.launch();
  const p2 = await b2.newPage();

  // Default: icon button, bottom-right, no text.
  await p2.goto(`http://localhost:${SITE_PORT}/`);
  const def = await p2.evaluate(() => {
    const sr = document.querySelector("#wnav-host")!.shadowRoot!;
    const btn = sr.querySelector(".launch") as HTMLElement;
    const a = sr.querySelector(".anchor") as HTMLElement;
    const cs = getComputedStyle(a);
    return {
      text: btn.textContent!.trim(),
      hasIcon: !!btn.querySelector("svg"),
      label: btn.getAttribute("aria-label"),
      bottom: cs.bottom,
      right: cs.right,
    };
  });
  assert.equal(def.text, "", "launcher should be icon-only, not text");
  assert(def.hasIcon, "launcher should contain an svg icon");
  assert(def.label && def.label.length > 3, "icon-only button needs an accessible name");
  assert.equal(def.bottom, "20px");
  assert.equal(def.right, "20px");
  ok(`icon-only, bottom-right, labelled "${def.label}"`);

  // The panel has a visible close button, not just the Escape key.
  await p2.click("#wnav-host .launch");
  await p2.click('#wnav-host button[aria-label="Close"]');
  const closed = await p2.evaluate(() => {
    const sr = document.querySelector("#wnav-host")!.shadowRoot!;
    return {
      panelOpen: sr.querySelector(".panel")!.classList.contains("open"),
      launcherShown: (sr.querySelector(".anchor") as HTMLElement).style.display !== "none",
      focusOnLauncher: sr.activeElement === sr.querySelector(".launch"),
    };
  });
  assert.deepEqual(closed, { panelOpen: false, launcherShown: true, focusOnLauncher: true });
  ok("close button hides the panel, brings the launcher back, returns focus to it");
  const note = await p2.evaluate(() => document.querySelector("#wnav-host")!.shadowRoot!.querySelector(".note")!.textContent);
  assert.match(note!, /pointed out on the page/i, "panel should say what picking something does");
  const head = await p2.evaluate(() => document.querySelector("#wnav-host")!.shadowRoot!.querySelector(".head")!.textContent);
  assert.match(head!, /where is/i, "the panel leads with the static words");
  assert.doesNotMatch(head!, /\bAI\b/, "nothing claims to be AI any more");

  // Host site takes over: its own trigger, its own corner, its own colour.
  await p2.goto(`http://localhost:${SITE_PORT}/custom`);
  const custom = await p2.evaluate(() => {
    const sr = document.querySelector("#wnav-host")!.shadowRoot!;
    return {
      builtInGone: !sr.querySelector(".anchor"),
      // .launch is gone with the anchor, so read the accent off the tooltip
      accent: getComputedStyle(sr.querySelector(".tip") as Element).backgroundColor,
    };
  });
  assert(custom.builtInGone, "data-trigger should suppress the built-in button entirely");
  assert.equal(
    await p2.evaluate(() => !!document.querySelector("#wnav-host")!.shadowRoot!.querySelector(".launch")),
    false,
    "our button should not be in the DOM at all when the site supplies its own",
  );
  assert.equal(custom.accent, "rgb(0, 128, 0)", "--wnav-accent from the page should apply");

  // Their own button opens the panel.
  await p2.click("#myHelp");
  const opened = await p2.evaluate(
    () => !!document.querySelector("#wnav-host")!.shadowRoot!.querySelector(".panel.open"),
  );
  assert(opened, "the host site's own element should open the panel");
  ok("data-trigger replaces it, and --wnav-accent restyles it");

  await b2.close();

  console.log("\n5. rate limits");
  const ask = (ip: string) =>
    fetch(`http://localhost:${NAV_PORT}/elements?site=${SITE}`, {
      headers: { "x-forwarded-for": ip },
    });

  // Per IP: ten index downloads a minute, then 429 with a wait time.
  for (let i = 1; i <= 10; i++) {
    const r = await ask("203.0.113.9");
    assert.equal(r.status, 200, `request ${i} of 10 should be allowed, got ${r.status}`);
  }
  const over = await ask("203.0.113.9");
  assert.equal(over.status, 429, "the 11th request in a minute should be refused");
  const wait = Number(over.headers.get("retry-after"));
  assert(wait >= 1 && wait <= 60, `Retry-After should be 1-60s, got ${wait}`);
  assert.equal((await over.json()).retryAfter, wait, "retryAfter in the body must match the header");
  // Behind an appending proxy the first X-Forwarded-For entry is the visitor's own
  // text. Forging it must not buy a fresh allowance.
  assert.equal((await ask("9.9.9.9, 203.0.113.9")).status, 429, "forged first XFF entry dodged the limit");
  const viaRealIp = await fetch(`http://localhost:${NAV_PORT}/elements?site=${SITE}`, {
    headers: { "x-real-ip": "203.0.113.9", "x-forwarded-for": "7.7.7.7" },
  });
  assert.equal(viaRealIp.status, 429, "X-Real-IP (set by the proxy) should win over X-Forwarded-For");
  assert.equal((await ask("198.51.100.4")).status, 200, "another visitor must be unaffected");
  ok(`11th request from one IP refused with Retry-After ${wait}s; other IPs unaffected`);

  console.log("\n6. origin allowlist");
  process.env.ALLOWED_ORIGINS = `${SITE}=http://localhost:${SITE_PORT}`;
  let ipN = 0; // a fresh address per call, so the per-IP limit stays out of the way
  const from = (origin: string | null, site = SITE) =>
    fetch(`http://localhost:${NAV_PORT}/elements?site=${site}`, {
      headers: {
        "x-forwarded-for": `10.9.0.${++ipN}`,
        ...(origin ? { origin } : {}),
      },
    });

  const good = await from(`http://localhost:${SITE_PORT}`);
  assert.equal(good.status, 200, "the registered origin should be served");
  assert.equal(good.headers.get("access-control-allow-origin"), `http://localhost:${SITE_PORT}`);

  const evil = await from("https://evil.example");
  assert.equal(evil.status, 403, "an unregistered origin must be refused");
  assert.equal(evil.headers.get("access-control-allow-origin"), null, "no CORS grant for it either");

  assert.equal((await from(null)).status, 403, "no Origin at all must be refused once a list is set");
  assert.equal(
    (await from(`http://localhost:${SITE_PORT}`, "someone-else")).status,
    403,
    "a registered origin must not be able to use another site's key",
  );

  const pre = await fetch(`http://localhost:${NAV_PORT}/elements`, {
    method: "OPTIONS",
    headers: { origin: `http://localhost:${SITE_PORT}` },
  });
  assert.equal(pre.headers.get("access-control-allow-origin"), `http://localhost:${SITE_PORT}`);
  delete process.env.ALLOWED_ORIGINS;
  ok("registered origin served; foreign origin, missing origin and cross-site key refused");

  console.log("\n7. never breaks the host page");
  // Accepts connections and never answers.
  const hang = http.createServer(() => {});
  await new Promise<void>((r) => hang.listen(8791, r));

  const b3 = await chromium.launch();
  const hostOk = async (path: string, act: (p: import("playwright").Page) => Promise<void>) => {
    const p = await b3.newPage();
    const errors: string[] = [];
    p.on("pageerror", (e) => errors.push(e.message)); // uncaught, i.e. into their page
    await p.goto(`http://localhost:${SITE_PORT}${path}`);
    await act(p);
    if (await p.locator("#hostBtn").count()) {
      await p.click("#hostBtn");
      assert.equal(await p.evaluate(() => (window as any).hostClicked), true, `${path}: host page broken`);
    }
    assert.deepEqual(errors, [], `${path}: widget threw into the host page`);
    return p;
  };
  const msgOf = (p: import("playwright").Page) =>
    p.evaluate(() => document.querySelector("#wnav-host")!.shadowRoot!.querySelector(".msg")!.textContent);
  const openIn = async (p: import("playwright").Page) => {
    await p.evaluate(() => (window as any).navigator_widget.open());
    await p.waitForTimeout(900); // past the widget's own data-timeout
  };

  let p = await hostOk("/down", (p) => openIn(p));
  assert.match((await msgOf(p))!, /couldn.t load/i, "API down should show a polite message");
  ok("API unreachable: polite message, no errors, host page still works");

  const t0 = Date.now();
  p = await hostOk("/hang", (p) => openIn(p));
  const took = Date.now() - t0;
  assert.match((await msgOf(p))!, /couldn.t load/i);
  assert(took < 5000, `a hanging API should time out at data-timeout (500ms), took ${took}ms`);
  ok(`API hangs: gave up after the timeout (${took}ms total), no errors`);

  p = await hostOk("/nostorage", async (p) => {
    await p.evaluate(async () => {
      await (window as any).navigator_widget.load();
      (window as any).navigator_widget.pick("Dark mode");
    });
    await p.waitForFunction(
      () => document.querySelector("#wnav-host")!.shadowRoot!.querySelector(".ring.on"),
      null,
      { timeout: 10000 },
    );
  });
  ok("sessionStorage blocked: walkthrough still starts, no errors");

  p = await hostOk("/twice", async () => {});
  assert.equal(await p.locator("#wnav-host").count(), 1, "included twice should still mean one widget");
  ok("script included twice: one widget");

  p = await hostOk("/head", async (p) => {
    await p.click("#late");
  });
  assert(
    await p.evaluate(
      () => !!document.querySelector("#wnav-host")!.shadowRoot!.querySelector(".panel.open"),
    ),
    "a script in <head> should still bind data-trigger to an element later in the body",
  );
  ok("script in <head>: waits for the body, binds data-trigger");

  await b3.close();
  hang.close();

  console.log("\n8. signed-in crawl");
  // A small app that keeps its session in IndexedDB, the way Firebase Auth does.
  // /logout comes first in the header: a crawler that followed it would clear
  // the session before ever reaching /account.
  const idb = `<script>
    const db = () => new Promise((ok) => { const r = indexedDB.open("auth", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("s"); r.onsuccess = () => ok(r.result); });
    const tx = async (mode, fn) => { const d = await db();
      return new Promise((ok) => { const t = d.transaction("s", mode); const q = fn(t.objectStore("s"));
        t.oncomplete = () => ok(q && q.result); }); };
    window.session = { get: () => tx("readonly", (s) => s.get("user")),
      set: () => tx("readwrite", (s) => s.put("ada", "user")), clear: () => tx("readwrite", (s) => s.delete("user")) };
  </script>`;
  const nav = `<nav><a href="/logout">Log out</a> <a href="/account">Account</a> <a href="/login">Sign in</a></nav>`;
  const app: Record<string, string> = {
    "/": `<!doctype html><body>${nav}<h1>Home</h1></body>`,
    "/login": `<!doctype html><body>${idb}${nav}
      <button id="go" onclick="session.set().then(() => (document.body.dataset.in = 1))">Log in</button></body>`,
    "/logout": `<!doctype html><body>${idb}${nav}<script>session.clear()</script></body>`,
    "/account": `<!doctype html><body>${idb}${nav}<main id="m"></main><script>
      session.get().then((u) => { m.innerHTML = u
        ? '<label for="inc">Monthly income</label><input id="inc">'
        : '<a href="/login">Sign in to see your details</a>'; });
    </script></body>`,
  };
  const appServer = http.createServer((q, r) => {
    const h = app[new URL(q.url!, "http://x").pathname];
    h ? r.writeHead(200, { "content-type": "text/html" }).end(h) : r.writeHead(404).end();
  });
  await new Promise<void>((r) => appServer.listen(8792, r));
  const APP = "http://localhost:8792";

  // Sign in once and save the session the way login.ts does -- and, for
  // comparison, the way Playwright does by default.
  const { saveSession } = await import("./login.ts");
  const b4 = await chromium.launch();
  const lctx = await b4.newContext();
  const lp = await lctx.newPage();
  await lp.goto(`${APP}/login`);
  await lp.click("#go");
  await lp.waitForSelector("body[data-in]");
  const authFile = "/tmp/wnav-test-auth.json";
  const plainFile = "/tmp/wnav-test-auth-plain.json";
  await saveSession(lctx, authFile);
  await lctx.storageState({ path: plainFile });
  await b4.close();

  const income = () => getElements("authdemo").find((e) => /monthly income/i.test(e.label));

  // The trap this guards: Playwright's default saved state leaves IndexedDB out,
  // so a Firebase-style login saves "fine" and the crawler is quietly signed out.
  await crawl("authdemo", `${APP}/`, { storageState: plainFile, respectRobots: false });
  assert.equal(income(), undefined, "default storageState should NOT carry an IndexedDB session");

  const r11 = await crawl("authdemo", `${APP}/`, { storageState: authFile, respectRobots: false });
  const inc = income();
  assert(inc, "signed-in crawl should find the account form (and must not have followed /logout)");
  assert.equal(inc.auth, 1, "account form should be marked signed-in only");
  const gate = getElements("authdemo").find((e) => /sign in to see/i.test(e.label));
  assert(gate, "signed-out-only content must survive the merge");
  assert.equal(gate.auth, 0);
  assert(r11.signedIn > 0);
  ok(`found ${r11.signedIn} signed-in-only element(s), kept signed-out ones, skipped /logout`);

  // Signed-in-only elements are offered like any other: the list is the index.
  const authIdx = await (await fetch(`http://localhost:${NAV_PORT}/elements?site=authdemo`)).json();
  assert(authIdx.elements.some((e: any) => /monthly income/i.test(e.label)),
    "a field only reachable when signed in should still be listed");
  ok("the signed-in crawl's finds are offered in the list too");

  appServer.close();

  console.log("\n9. late-rendering targets and detours");
  // Both are indexed against another page, as anything found by the crawl is.
  putElements(SITE, [
    { page: "/settings", label: "Late field", role: "input", parent: "" },
  ]);

  const b5 = await chromium.launch();
  const tipOf = (p: import("playwright").Page) =>
    p.evaluate(() => {
      const sr = document.querySelector("#wnav-host")!.shadowRoot!;
      const r = sr.querySelector(".ring") as HTMLElement;
      return {
        on: r.classList.contains("on"),
        x: parseFloat(r.style.left), y: parseFloat(r.style.top),
        step: sr.querySelector(".tip b")!.textContent, hint: sr.querySelector(".tip span")!.textContent,
      };
    });

  // The field appears after 1s; the link is there from the start. The field must win.
  const lp5 = await b5.newPage();
  await lp5.goto(`http://localhost:${SITE_PORT}/late`);
  await lp5.evaluate(async () => {
    await (window as any).navigator_widget.load();
    (window as any).navigator_widget.pick("Late field");
  });
  await lp5.waitForTimeout(3500); // past both the render and the link grace period
  const field = (await lp5.locator("#lf").boundingBox())!;
  const t12 = await tipOf(lp5);
  assert(Math.abs(t12.x - field.x) < 20 && Math.abs(t12.y - field.y) < 20,
    `spotlight should be on the late field, not the link: ${JSON.stringify(t12)}`);
  assert.match(t12.hint!, /Late field/, `expected the field's own hint: ${t12.hint}`);
  ok("a field that renders late beats a link to another page");

  // Genuinely elsewhere: offer the link, say it's a detour, and don't count it as the step.
  const dp = await b5.newPage();
  await dp.goto(`http://localhost:${SITE_PORT}/detour`);
  await dp.evaluate(async () => {
    await (window as any).navigator_widget.load();
    (window as any).navigator_widget.pick("Appearance");
  });
  await dp.waitForFunction(
    () => document.querySelector("#wnav-host")!.shadowRoot!.querySelector(".ring.on"), null, { timeout: 6000 });
  assert.match((await tipOf(dp)).hint!, /go here first/i, "a detour link should say it is a detour");
  await dp.click("a[href='/settings']");
  await dp.waitForURL("**/settings");
  await dp.waitForFunction(
    () => document.querySelector("#wnav-host")!.shadowRoot!.querySelector(".ring.on"), null, { timeout: 8000 });
  const after = await tipOf(dp);
  assert.equal(after.step, "Step 1 of 1", "following the detour must not count as doing the step");
  assert.match(after.hint!, /Appearance/);
  ok("detour link is labelled as one, and following it resumes the same step");
  await b5.close();

  console.log("\n10. hidden behind a collapsed menu");
  putElements(SITE, [{ page: "/rail", label: "Affordability Index", role: "a", parent: "" }]);
  const b6 = await chromium.launch();
  const rp = await b6.newPage();
  await rp.goto(`http://localhost:${SITE_PORT}/rail`);
  await rp.evaluate(async () => {
    await (window as any).navigator_widget.load();
    (window as any).navigator_widget.pick("Affordability Index");
  });
  await rp.waitForFunction(
    () => document.querySelector("#wnav-host")!.shadowRoot!.querySelector(".ring.on"), null, { timeout: 5000 });
  const railToggle = (await rp.locator("#rt").boundingBox())!;
  let t13 = await tipOf(rp);
  // Before the fix the ring sat at x < 0: on the off-screen link itself.
  assert(t13.x >= 0, `spotlight is off-screen: ${JSON.stringify(t13)}`);
  assert(Math.abs(t13.x - railToggle.x) < 20 && Math.abs(t13.y - railToggle.y) < 20,
    `should point at the menu toggle first: ${JSON.stringify(t13)}`);
  assert.match(t13.hint!, /open this first/i);
  await rp.click("#rt");
  await rp.waitForFunction(
    () => /Here it is/.test(document.querySelector("#wnav-host")!.shadowRoot!.querySelector(".tip span")!.textContent!),
    null, { timeout: 5000 });
  const link = (await rp.locator("#rail a").boundingBox())!;
  t13 = await tipOf(rp);
  assert(Math.abs(t13.x - link.x) < 20 && Math.abs(t13.y - link.y) < 20, `should now be on the link: ${JSON.stringify(t13)}`);
  assert.equal(t13.step, "Step 1 of 1", "opening the menu must not count as the step");
  ok("off-screen rail: points at its toggle first, then at the link inside");
  await b6.close();

  console.log("\n11. the step's element disappears");
  putElements(SITE, [
    { page: "/menu", label: "Account menu", role: "button", parent: "" },
    { page: "/menu", label: "Dark mode", role: "menuitem", parent: "Account menu" },
  ]);

  // Check 8 spent this address's allowance; the browser can't spoof one.
  const ipLimit = process.env.RATE_IP_PER_MIN;
  process.env.RATE_IP_PER_MIN = "1000";

  const b7 = await chromium.launch();
  const mp = await b7.newPage();
  await mp.goto(`http://localhost:${SITE_PORT}/menu`);
  await mp.evaluate(async () => {
    await (window as any).navigator_widget.load();
    (window as any).navigator_widget.pick("Dark mode");
  });
  await mp.waitForTimeout(800);
  await mp.click("#mt"); // opens the menu; step 2's item is now on the page
  await mp.waitForTimeout(600);
  const item = (await mp.locator("#dm").boundingBox())!;
  let t16 = await tipOf(mp);
  assert(Math.abs(t16.x - item.x) < 20 && Math.abs(t16.y - item.y) < 20,
    `should ring the menu item: ${JSON.stringify(t16)}`);

  // Close it again: the item is removed from the DOM entirely.
  await mp.click("#mt");
  await mp.waitForTimeout(900);
  t16 = await tipOf(mp);
  const menuBtn = (await mp.locator("#mt").boundingBox())!;
  assert(!(t16.on && Math.abs(t16.x - item.x) < 20 && Math.abs(t16.y - item.y) < 20),
    `ring stayed on the empty space the menu left: ${JSON.stringify(t16)}`);
  if (t16.on)
    assert(Math.abs(t16.x - menuBtn.x) < 20 && Math.abs(t16.y - menuBtn.y) < 20,
      `if anything is ringed it should be the menu's own button: ${JSON.stringify(t16)}`);
  ok("ring drops the vanished menu item instead of freezing over what replaced it");
  await b7.close();
  if (ipLimit === undefined) delete process.env.RATE_IP_PER_MIN;
  else process.env.RATE_IP_PER_MIN = ipLimit;

  console.log("\n12. the opener is the step before it");
  putElements(SITE, [
    { page: "/popup", label: "Account menu", role: "button", parent: "" },
    { page: "/popup", label: "Dark mode", role: "menuitem", parent: "Account menu" },
  ]);

  const ipLimit18 = process.env.RATE_IP_PER_MIN;
  process.env.RATE_IP_PER_MIN = "1000";
  const b8 = await chromium.launch();
  const pp = await b8.newPage();
  await pp.goto(`http://localhost:${SITE_PORT}/popup`);
  await pp.evaluate(async () => {
    await (window as any).navigator_widget.load();
    (window as any).navigator_widget.pick("Dark mode");
  });
  await pp.waitForTimeout(700);
  await pp.click("#pt");            // step 1: opens the menu
  await pp.waitForTimeout(500);
  await pp.click("#pt");            // and the visitor closes it again
  await pp.waitForTimeout(3500);    // past the link grace period

  const t18 = await tipOf(pp);
  const pBtn = (await pp.locator("#pt").boundingBox())!;
  assert(t18.on, `widget gave up instead of pointing at the menu: ${JSON.stringify(t18)}`);
  assert(Math.abs(t18.x - pBtn.x) < 20 && Math.abs(t18.y - pBtn.y) < 20,
    `should point back at the menu button: ${JSON.stringify(t18)}`);
  assert.match(t18.hint!, /open this first/i);
  assert.equal(t18.step, "Step 2 of 2", "reopening the menu is not a step of its own");

  // And opening it again resumes the real step.
  await pp.click("#pt");
  await pp.waitForFunction(
    () => /here it is/i.test(document.querySelector("#wnav-host")!.shadowRoot!.querySelector(".tip span")!.textContent!),
    null, { timeout: 5000 });
  ok("no aria-controls: points back at the menu, then at the item once it is open");
  await b8.close();
  if (ipLimit18 === undefined) delete process.env.RATE_IP_PER_MIN;
  else process.env.RATE_IP_PER_MIN = ipLimit18;

  console.log("\n\x1b[32mall passed\x1b[0m\n");
} finally {
  siteServer.close();
  navServer.close();
}
process.exit(0);
