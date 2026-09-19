// Builds the site index: every interactive element, which page it lives on, and
// which menu it hides behind. This is what lets a single query-time model call
// answer "where is dark mode" without walking the user through the site first.
import { chromium, type Page } from "playwright";
import { clearSite, putElements, type El } from "./db.ts";

const INTERACTIVE =
  'a[href], button, summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="switch"], [role="checkbox"], input:not([type="hidden"]), select, textarea';

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
};

/** Runs in the page. Returns one record per visible interactive element. */
function extract(sel: string) {
  const label = (el: Element): string => {
    const a = el as HTMLElement;
    const raw =
      a.getAttribute("aria-label") ||
      a.getAttribute("title") ||
      (a as HTMLInputElement).placeholder ||
      a.innerText ||
      a.getAttribute("alt") ||
      (a as HTMLInputElement).value ||
      "";
    return raw.replace(/\s+/g, " ").trim().slice(0, 60);
  };
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
  };
  const out: { label: string; role: string }[] = [];
  for (const el of Array.from(document.querySelectorAll(sel))) {
    if (!visible(el)) continue;
    const l = label(el);
    if (!l) continue;
    out.push({
      label: l,
      role: el.getAttribute("role") || el.tagName.toLowerCase(),
    });
  }
  return out;
}

async function snapshot(page: Page) {
  return page.evaluate(extract, INTERACTIVE);
}

async function crawlPage(page: Page, url: string, origin: string) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(400); // let client-side rendering land

  const path = new URL(page.url()).pathname;
  const base = await snapshot(page);
  const els: El[] = base.map((e) => ({ ...e, page: path, parent: "" }));

  const links = await page.evaluate(
    () =>
      Array.from(document.querySelectorAll("a[href]")).map(
        (a) => (a as HTMLAnchorElement).href,
      ),
  );

  // Depth 1: open each disclosure, record what appears inside it.
  // ponytail: one level deep. Nested submenus need a recursive pass -- add it
  // when a real site's target actually sits two menus down.
  const seen = new Set(base.map((e) => e.label));
  const openers = await page.evaluate(
    ({ sel, words }) => {
      const re = new RegExp(words, "i");
      return Array.from(document.querySelectorAll(sel))
        .filter((el) => {
          const t = (el as HTMLElement).innerText?.trim() ?? "";
          const aria = el.getAttribute("aria-label") ?? "";
          return (
            el.hasAttribute("aria-haspopup") ||
            el.getAttribute("aria-expanded") === "false" ||
            el.tagName === "SUMMARY" ||
            // A tab reveals a hidden panel exactly like a disclosure does, and
            // switching tabs is never destructive.
            el.getAttribute("role") === "tab" ||
            re.test(t) ||
            re.test(aria)
          );
        })
        .map((el) => (el as HTMLElement).innerText?.trim() || el.getAttribute("aria-label") || "")
        .filter(Boolean)
        .slice(0, 12);
    },
    { sel: INTERACTIVE, words: DISCLOSURE_WORDS.source },
  );

  for (const opener of openers) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(200);
      const target = page.locator(`${INTERACTIVE}`, { hasText: opener }).first();
      if (!(await target.count())) continue;

      /* Record the parent under the SAME name the element gets as a row. We find
       * openers by innerText but label rows by aria-label first, so a control with
       * both ends up under two spellings and the ancestor chain breaks. */
      const canonical = await target.evaluate((el) => {
        const a = el as HTMLElement;
        return (a.getAttribute("aria-label") || a.getAttribute("title") || a.innerText || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 60);
      });

      await target.click({ timeout: 2000, noWaitAfter: true });
      await page.waitForTimeout(400);
      if (new URL(page.url()).pathname !== path) continue; // it navigated; the link crawl covers it
      for (const e of await snapshot(page)) {
        if (seen.has(e.label)) continue;
        seen.add(e.label);
        els.push({ ...e, page: path, parent: canonical || opener });
      }
    } catch {
      // A disclosure that won't open is not a crawl failure.
    }
  }

  const next = links
    .filter((h) => h.startsWith(origin))
    .map((h) => h.split("#")[0]);
  return { els, next };
}

export async function crawl(site: string, startUrl: string, opts: CrawlOpts = {}) {
  const { maxPages = 40, storageState, headless = true } = opts;
  const origin = new URL(startUrl).origin;

  const browser = await chromium.launch({ headless });
  const ctx = await browser.newContext(storageState ? { storageState } : {});
  const page = await ctx.newPage();

  const queue = [startUrl];
  const done = new Set<string>();
  const all: El[] = [];

  try {
    while (queue.length && done.size < maxPages) {
      const url = queue.shift()!;
      const key = new URL(url).pathname;
      if (done.has(key)) continue;
      done.add(key);
      try {
        const { els, next } = await crawlPage(page, url, origin);
        all.push(...els);
        for (const n of next) if (!done.has(new URL(n).pathname)) queue.push(n);
      } catch (err) {
        console.warn(`  skipped ${url}: ${(err as Error).message}`);
      }
    }
  } finally {
    await browser.close();
  }

  clearSite(site);
  putElements(site, all);
  return { pages: done.size, elements: all.length };
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
  console.log(`indexed ${res.elements} elements across ${res.pages} pages for "${site}"`);
}
