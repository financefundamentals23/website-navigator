// Builds the site index: every interactive element, which page it lives on, and
// which menu it hides behind. This is what lets a single query-time model call
// answer "where is dark mode" without walking the user through the site first.
import { readFileSync } from "node:fs";
import { chromium, type Page } from "playwright";
import { clearSite, putElements, type El } from "./db.ts";

// Same scanner the widget uses, so index labels match what the widget looks for.
const SCAN_SRC = readFileSync(new URL("./scan.js", import.meta.url), "utf8");

// Opening a menu means clicking it. On a stranger's site that is not a free
// action -- a click can submit a form, delete a row, or spend money. So we only
// click things that announce themselves as disclosures, or whose label is one of
// the handful of nav words below. Never "every button".
const DISCLOSURE_WORDS =
  /^(menu|settings|preferences|account|profile|options|more|appearance|theme|display|help|tools|view|edit)$/i;

export type CrawlOpts = {
  maxPages?: number;
  storageState?: string; // Playwright auth state -- without it, logged-in pages are invisible
  headless?: boolean;
  respectRobots?: boolean; // default true; only turn off for a site you own
};

/* Read robots.txt and honour it. Pointed at your own site this changes nothing,
 * but the crawler opens a real browser and clicks things, and without this it
 * will happily walk into /gp/cart and /ap/signin on someone else's domain. */
async function robotsGate(origin: string): Promise<(path: string) => boolean> {
  const rules: { allow: boolean; path: string; re: RegExp }[] = [];
  try {
    const res = await fetch(`${origin}/robots.txt`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return () => true; // no robots.txt means no restrictions
    let applies = false;
    for (const raw of (await res.text()).split(/\r?\n/)) {
      const line = raw.split("#")[0].trim();
      const i = line.indexOf(":");
      if (i < 0) continue;
      const key = line.slice(0, i).trim().toLowerCase();
      const val = line.slice(i + 1).trim();
      if (key === "user-agent") applies = val === "*";
      else if (applies && (key === "allow" || key === "disallow") && val) {
        const re = new RegExp(
          "^" +
            val
              .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
              .replace(/\*/g, ".*")
              .replace(/\\\$$/, "$"),
        );
        rules.push({ allow: key === "allow", path: val, re });
      }
    }
  } catch {
    return () => true; // unreachable robots.txt is not a licence, but it is not a crawl failure either
  }
  if (!rules.length) return () => true;

  return (path: string) => {
    // Most specific rule wins, and Allow beats Disallow at equal length.
    let best: (typeof rules)[number] | null = null;
    for (const r of rules) {
      if (!r.re.test(path)) continue;
      if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))
        best = r;
    }
    return !best || best.allow;
  };
}

/** Runs in the page, using the injected shared scanner. */
function extract() {
  const S = (window as any).__wnavScan;
  const out: { label: string; role: string }[] = [];
  for (const el of S.all()) {
    if (!S.isVisible(el)) continue;
    const label = S.nameOf(el);
    if (!label) continue;
    out.push({ label, role: S.roleOf(el) });
  }
  return out;
}

async function snapshot(page: Page) {
  return page.evaluate(extract);
}

async function crawlPage(page: Page, url: string, origin: string) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  /* Wait for something to actually be laid out, not a fixed delay. A heavy site
   * has its markup at domcontentloaded but no geometry yet, so every element
   * measures 0x0 and the visibility filter throws the whole page away -- which is
   * how amazon.com indexed as zero elements. */
  await page
    .waitForFunction(
      () =>
        Array.from(document.querySelectorAll('a[href], button, input, [role="button"]')).some(
          (el) => {
            const r = el.getBoundingClientRect();
            return r.width > 2 && r.height > 2;
          },
        ),
      null,
      { timeout: 8000 },
    )
    .catch(() => {}); // a page with genuinely nothing on it is not an error
  await page.waitForTimeout(300); // let the rest of the fold settle

  const path = new URL(page.url()).pathname;
  const base = await snapshot(page);
  const els: El[] = base.map((e) => ({ ...e, page: path, parent: "" }));

  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a[href]")).map((a) => (a as HTMLAnchorElement).href),
  );

  /* Open each disclosure and record what appears inside it.
   * Tag them in the page first, then click by tag: the names we match on come
   * from the same scanner that labels index rows, so a parent can never be
   * recorded under a different spelling than the row it points at. */
  const tag = async () =>
    page.evaluate(
      (words) => {
        const S = (window as any).__wnavScan;
        const re = new RegExp(words, "i");
        const found: { id: number; name: string }[] = [];
        let i = 0;
        for (const el of S.all()) {
          if (!S.isVisible(el) || S.isDisabled(el)) continue;
          const name = S.nameOf(el);
          if (!name) continue;
          const declares =
            el.hasAttribute("aria-haspopup") || el.hasAttribute("aria-expanded");
          // A plain link is navigation, not a disclosure. Clicking it reloads the
          // page (wiping these very markers) and the link crawl already covers
          // where it goes.
          if (el.tagName === "A" && el.getAttribute("href") && !declares) continue;
          const opens =
            el.hasAttribute("aria-haspopup") ||
            el.getAttribute("aria-expanded") === "false" ||
            el.tagName === "SUMMARY" ||
            // A tab reveals a hidden panel exactly like a disclosure does, and
            // switching tabs is never destructive.
            el.getAttribute("role") === "tab" ||
            re.test(name);
          if (!opens) continue;
          el.setAttribute("data-wnav-open", name.replace(/["\\]/g, ""));
          found.push({ id: i++, name: name.replace(/["\\]/g, "") });
          if (i >= 12) break;
        }
        return found;
      },
      DISCLOSURE_WORDS.source,
    );

  const openers = await tag();
  const seen = new Set(base.map((e) => e.label));

  for (const { name } of openers) {
    try {
      // Re-tag every time: opening a menu, or a click that reloads the same path,
      // wipes the markers we navigate by.
      await tag();
      const target = page.locator(`[data-wnav-open="${name}"]`).first();
      if (!(await target.count())) continue;
      // Some menus only appear on hover; hovering first costs nothing for the rest.
      await target.hover({ timeout: 1500 }).catch(() => {});
      await page.waitForTimeout(150);
      for (const e of await snapshot(page)) {
        if (seen.has(e.label)) continue;
        seen.add(e.label);
        els.push({ ...e, page: path, parent: name });
      }
      await target.click({ timeout: 2000, noWaitAfter: true });
      await page.waitForTimeout(350);
      if (new URL(page.url()).pathname !== path) {
        // It navigated; the link crawl covers that page. Come back and re-tag.
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(300);
        continue;
      }
      for (const e of await snapshot(page)) {
        if (seen.has(e.label)) continue;
        seen.add(e.label);
        els.push({ ...e, page: path, parent: name });
      }
    } catch {
      // A disclosure that will not open is not a crawl failure.
    }
  }

  const next = links
    .filter((h) => h.startsWith(origin))
    .map((h) => h.split("#")[0]);
  return { els, next };
}

/* A crawl follows every same-origin link, and following a logout link ends the
 * signed-in session partway through. Never navigate to one. */
const LOGOUT = /log-?out|sign-?out|log-?off/i;

type WalkOpts = {
  maxPages: number;
  headless: boolean;
  allowed: (path: string) => boolean;
  storageState?: string;
};

async function walk(startUrl: string, { maxPages, headless, allowed, storageState }: WalkOpts) {
  const origin = new URL(startUrl).origin;
  const browser = await chromium.launch({ headless });
  const ctx = await browser.newContext(storageState ? { storageState } : {});
  await ctx.addInitScript({ content: SCAN_SRC }); // same scanner the widget uses
  const page = await ctx.newPage();

  const queue = [startUrl];
  const done = new Set<string>();
  const els: El[] = [];
  let blocked = 0;

  try {
    while (queue.length && done.size < maxPages) {
      const url = queue.shift()!;
      const key = new URL(url).pathname;
      if (done.has(key) || LOGOUT.test(key)) continue;
      if (!allowed(key)) {
        blocked++;
        continue;
      }
      done.add(key);
      try {
        const res = await crawlPage(page, url, origin);
        els.push(...res.els);
        for (const n of res.next) if (!done.has(new URL(n).pathname)) queue.push(n);
      } catch (err) {
        console.warn(`  skipped ${url}: ${(err as Error).message}`);
      }
    }
  } finally {
    await browser.close();
  }
  return { els, pages: done, blocked };
}

export async function crawl(site: string, startUrl: string, opts: CrawlOpts = {}) {
  const { maxPages = 40, storageState, headless = true, respectRobots = true } = opts;
  const allowed = respectRobots ? await robotsGate(new URL(startUrl).origin) : () => true;

  const out = await walk(startUrl, { maxPages, headless, allowed });
  const all: El[] = out.els;
  const pages = new Set(out.pages);
  let blocked = out.blocked;
  let signedIn = 0;

  if (storageState) {
    /* Crawl both ways. Signed in only would lose whatever exists only when
     * signed out -- the sign-in link itself, for a start. Signed out only can't
     * see the account area at all, which is how a real site got told it "does
     * not have" a setting that sits on its profile page. Rows that appear only
     * in the signed-in pass are marked, so the guide can say "sign in first". */
    const inn = await walk(startUrl, { maxPages, headless, allowed, storageState });
    const key = (e: El) => `${e.page}|${e.label}|${e.parent}`;
    const seenOut = new Set(all.map(key));
    for (const e of inn.els) {
      if (seenOut.has(key(e))) continue;
      seenOut.add(key(e));
      all.push({ ...e, auth: 1 });
      signedIn++;
    }
    for (const p of inn.pages) pages.add(p);
    blocked = Math.max(blocked, inn.blocked);
    if (!signedIn) {
      console.warn(
        "  the signed-in crawl found nothing the signed-out one didn't -- has the session expired? Re-run: node login.ts <url>",
      );
    }
  }

  if (blocked) console.log(`  skipped ${blocked} path(s) disallowed by robots.txt`);

  clearSite(site);
  putElements(site, all);
  return { pages: pages.size, elements: all.length, blocked, signedIn };
}

if (import.meta.filename === process.argv[1]) {
  const [site, url] = process.argv.slice(2);
  if (!site || !url) {
    console.error("usage: node crawl.ts <site-key> <start-url> [--auth state.json]");
    process.exit(1);
  }
  const authFlag = process.argv.indexOf("--auth");
  const res = await crawl(site, url, {
    storageState: authFlag > -1 ? process.argv[authFlag + 1] : undefined,
  });
  console.log(
    `indexed ${res.elements} elements across ${res.pages} pages for "${site}"` +
      (res.signedIn ? ` (${res.signedIn} only when signed in)` : ""),
  );
}
