/* End-to-end check: crawl a demo site, ask where dark mode is, and drive the
 * real widget in a real browser. Run: npm test  */
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import { crawl } from "./crawl.ts";
import { db, getElements } from "./db.ts";

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

  console.log("\n2. guide");
  let guide = await post("/guide", { site: SITE, query: "where is dark mode?", url: "/" });
  let stubbed = false;
  const guideErr = guide.error;
  if (guide.error?.match(/api key|auth|credential|fetch failed|ECONNREFUSED|40[0-3]|429/i)) {
    // No model reachable here. Seed the cache with the path it would return, so the
    // widget checks below still run for real -- they are the bulk of the code.
    stubbed = true;
    db.prepare(`INSERT OR REPLACE INTO answers (site, q, json, created) VALUES (?, ?, ?, ?)`).run(
      SITE,
      "where is dark mode",
      JSON.stringify({
        answer: "Dark mode is under Settings -> Appearance.",
        confidence: 0.9,
        steps: [
          { label: "Settings", role: "a", page: "/", hint: "Open Settings" },
          { label: "Appearance", role: "summary", page: "/settings", hint: "Expand Appearance" },
          { label: "Dark mode", role: "switch", page: "/settings", hint: "Toggle Dark mode" },
        ],
      }),
      Date.now(),
    );
    guide = await post("/guide", { site: SITE, query: "where is dark mode?", url: "/" });
    console.log(`  \x1b[33mstub\x1b[0m no model reachable (${String(guideErr).slice(0, 80)}) - canned path so 3-4 still run`);
  }
  assert(!guide.error, `guide failed: ${guide.error}`);
  assert(guide.steps.length >= 2, `expected a multi-step path, got ${guide.steps.length}`);
  assert(
    /dark/i.test(guide.steps.at(-1).label),
    `last step should be the toggle, got '${guide.steps.at(-1).label}'`,
  );
  ok(`${stubbed ? "(stubbed) " : ""}${guide.steps.length} steps: ${guide.steps.map((s: any) => s.label).join(" -> ")}`);

  console.log("\n3. widget in a browser");
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`http://localhost:${SITE_PORT}/`);

  await page.click("#wnav-host .launch");
  await page.fill("#wnav-host input", "where is dark mode?");
  await page.press("#wnav-host input", "Enter");
  await page.waitForFunction(
    () => document.querySelector("#wnav-host")!.shadowRoot!.querySelector(".ring.on"),
    null,
    { timeout: 10000 },
  );

  // The ring must actually sit on the gear, not just exist.
  const gear = (await page.locator('a[aria-label="Settings"]').boundingBox())!;
  const ringBox = await page.evaluate(() => {
    const r = document.querySelector("#wnav-host")!.shadowRoot!.querySelector(".ring") as HTMLElement;
    return { x: parseFloat(r.style.left), y: parseFloat(r.style.top) };
  });
  assert(Math.abs(ringBox.x - gear.x) < 20 && Math.abs(ringBox.y - gear.y) < 20,
    `ring at ${JSON.stringify(ringBox)} is not on the gear at ${JSON.stringify(gear)}`);
  ok("step 1 highlights the settings link");

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
  assert(/Step [2-9]/.test(stepText!), `expected to advance past step 1, got '${stepText}'`);
  ok(`survived the page navigation and resumed at '${stepText}'`);

  // The real test of the polling logic: "Dark mode" is not in the DOM's visible
  // tree until this click expands the accordion.
  await page.click("summary:text('Appearance')");
  await page.waitForFunction(
    () => {
      const sr = document.querySelector("#wnav-host")!.shadowRoot!;
      return sr.querySelector(".ring.on") && /Step 3/.test(sr.querySelector(".tip b")!.textContent!);
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
  ok("step 3 waited for the accordion to open, then highlighted the Dark mode toggle");

  await browser.close();

  console.log("\n4. cache");
  guide = await post("/guide", { site: SITE, query: "Where is DARK MODE??", url: "/" });
  assert.equal(guide.cached, true, "second identical question should not hit the model");
  ok("repeat question answered from cache, no model call");

  console.log("\n5. invented labels are rejected");
  // Stand in for the model with a server that returns one real step and one the
  // site has never had. A weaker free model does exactly this, and an invented
  // label sends the widget hunting for something that isn't there.
  const fake = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                answer: "Teleport straight there.",
                confidence: 0.95,
                steps: [
                  { label: "Settings", role: "a", page: "/", hint: "Open Settings" },
                  { label: "Teleport to dark mode", role: "button", page: "/", hint: "Click it" },
                ],
              }),
            },
          },
        ],
      }),
    );
  });
  await new Promise<void>((r) => fake.listen(8797, r));
  process.env.LLM_BASE_URL = "http://localhost:8797";

  const bad = await post("/guide", { site: SITE, query: "beam me to dark mode", url: "/" });
  fake.close();
  delete process.env.LLM_BASE_URL;

  assert.deepEqual(
    bad.steps.map((s: any) => s.label),
    ["Settings"],
    `invented step survived: ${JSON.stringify(bad.steps)}`,
  );
  assert(bad.confidence <= 0.3, `confidence should drop after a rejection, got ${bad.confidence}`);
  ok("kept the real step, dropped the invented one, lowered confidence");

  console.log("\n6. skipped 'open this first' steps are put back");
  // The model reliably names the destination and just as reliably forgets the
  // collapsed panel in front of it, which strands the visitor on a page where the
  // target isn't visible. The index knows the chain, so the server inserts it.
  const lazy = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                answer: "Toggle dark mode.",
                confidence: 0.9,
                // Only the destination -- no "Appearance", and a junk page field
                // of the kind real models emit (" /", "/*", `["\"\"]`).
                steps: [{ label: "Dark mode", role: "switch", page: " /*", hint: "Toggle it" }],
              }),
            },
          },
        ],
      }),
    );
  });
  await new Promise<void>((r) => lazy.listen(8796, r));
  process.env.LLM_BASE_URL = "http://localhost:8796";

  const chained = await post("/guide", { site: SITE, query: "dark mode please", url: "/settings" });
  lazy.close();
  delete process.env.LLM_BASE_URL;

  assert.deepEqual(
    chained.steps.map((s: any) => s.label),
    ["Appearance", "Dark mode"],
    `expected the accordion step to be inserted, got ${JSON.stringify(chained.steps)}`,
  );
  // Page comes from the index, never from the model's junk field.
  assert.deepEqual(chained.steps.map((s: any) => s.page), ["/settings", "/settings"]);
  ok("inserted the 'Appearance' step and resolved pages from the index");

  console.log("\n7. the launcher is the host site's to place and style");
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

  console.log("\n\x1b[32mall passed\x1b[0m\n");
} finally {
  siteServer.close();
  navServer.close();
}
process.exit(0);
