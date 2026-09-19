/* Local test harness: serves a static site folder with the widget injected, and
 * indexes it first, so you can try the navigator against a real site without
 * deploying anything.
 *
 *   npm run dev -- ../finance-calculator-tools
 */
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, basename, resolve } from "node:path";
import { crawl } from "./crawl.ts";

const folder = resolve(process.argv[2] ?? ".");
const site = process.argv[3] ?? basename(folder);
const NAV = Number(process.env.PORT ?? 8787);
const SITE = NAV + 1;

if (!existsSync(folder)) {
  console.error(`no such folder: ${folder}`);
  process.exit(1);
}

const TYPES: Record<string, string> = {
  ".html": "text/html", ".css": "text/css", ".js": "application/javascript",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".woff2": "font/woff2", ".json": "application/json", ".xml": "application/xml",
  ".txt": "text/plain", ".ico": "image/x-icon",
};

const TAG = `<script src="http://localhost:${NAV}/nav.js" data-site="${site}" data-api="http://localhost:${NAV}"></script>`;

const siteServer = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url!, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  let file = join(folder, p);
  // Clean URLs, the way a static host's rewrite rules do it.
  if (!existsSync(file) && existsSync(`${file}.html`)) file = `${file}.html`;
  if (!existsSync(file)) return res.writeHead(404).end("not found");

  const type = TYPES[extname(file)] ?? "application/octet-stream";
  let body: string | Buffer = readFileSync(file);
  if (type === "text/html") {
    const html = body.toString();
    body = html.includes("</body>") ? html.replace("</body>", `${TAG}</body>`) : html + TAG;
  }
  res.writeHead(200, { "content-type": type }).end(body);
});

const { server: navServer } = await import("./server.ts");
await new Promise<void>((r) => siteServer.listen(SITE, r));
await new Promise<void>((r) => navServer.listen(NAV, r));

console.log(`serving ${folder} on http://localhost:${SITE} (widget injected)`);
console.log(`indexing as "${site}"...`);
const res = await crawl(site, `http://localhost:${SITE}/`);
console.log(`indexed ${res.elements} elements across ${res.pages} pages`);
console.log(`\n  open http://localhost:${SITE} and click "Find anything"\n`);
