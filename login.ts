/* Save a signed-in session for the crawler.
 *
 *   node login.ts https://financefundamentals.app [auth.json]
 *
 * Opens a real browser window. Sign in there as you normally would, then come
 * back here and press Enter. The session is written to auth.json, which then
 * goes to the crawler:  node crawl.ts <site> <url> --auth auth.json
 *
 * auth.json is a live login -- anyone holding it is signed in as you. It is
 * gitignored; keep it that way, and use a test account rather than your own. */
import { chromium, type BrowserContext } from "playwright";

/* IndexedDB is off by default in Playwright's saved state, and Firebase Auth
 * keeps its session there. Without this the file saves fine and the crawler is
 * quietly signed out. */
export const saveSession = (ctx: BrowserContext, path: string) =>
  ctx.storageState({ path, indexedDB: true });

if (import.meta.filename === process.argv[1]) {
  const [url, out = "auth.json"] = process.argv.slice(2);
  if (!url) {
    console.error("usage: node login.ts <site-url> [auth.json]");
    process.exit(1);
  }
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext();
  await (await ctx.newPage()).goto(url);
  console.log("Sign in in the browser window, then press Enter here.");
  await new Promise((r) => process.stdin.once("data", r));
  await saveSession(ctx, out);
  await browser.close();
  console.log(`saved to ${out} -- now: node crawl.ts <site> ${url} --auth ${out}`);
  process.exit(0);
}
