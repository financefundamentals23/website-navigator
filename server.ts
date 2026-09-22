import http from "node:http";
import { readFileSync } from "node:fs";
import { db, getElements, type El } from "./db.ts";

const PORT = Number(process.env.PORT ?? 8787);
const ADMIN_KEY = process.env.NAV_ADMIN_KEY ?? "";

/* One limit: an address pulling the index more than ~10 times a minute is not a
 * visitor. The widget fetches it once per page load and keeps it in memory.
 * Read per call, so it can be tuned without a restart.
 * ponytail: fixed windows in process memory -- per server instance, and a burst
 * straddling a window edge can reach 2x. Move to Redis when running >1 instance. */
function limiter(max: () => number, windowMs = 60_000) {
  const hits = new Map<string, { n: number; reset: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs).unref();

  // Returns 0 when allowed, otherwise the seconds until the window resets.
  return (key: string) => {
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.reset <= now) hits.set(key, (h = { n: 0, reset: now + windowMs }));
    h.n++;
    return h.n <= max() ? 0 : Math.max(1, Math.ceil((h.reset - now) / 1000));
  };
}

const perIp = limiter(() => Number(process.env.RATE_IP_PER_MIN ?? 10));

class RateLimited extends Error {
  retryAfter: number;
  constructor(retryAfter: number, message: string) {
    super(message);
    this.retryAfter = retryAfter;
  }
}

/* Behind a proxy the socket address is the proxy's, so every visitor would share
 * one limit; TRUST_PROXY=1 reads the client from headers instead. Only then:
 * without a proxy those headers are whatever the caller typed.
 * X-Real-IP first -- Railway sets it to the client address. Failing that, the
 * LAST X-Forwarded-For entry: a proxy appends what it saw, so the last entry is
 * the proxy's word and every entry before it is the visitor's, forgeable per
 * request to dodge the per-IP limit. */
function clientIp(req: http.IncomingMessage) {
  if (process.env.TRUST_PROXY === "1") {
    const real = String(req.headers["x-real-ip"] ?? "").trim();
    if (real) return real;
    const last = String(req.headers["x-forwarded-for"] ?? "").split(",").pop()!.trim();
    if (last) return last;
  }
  return req.socket.remoteAddress ?? "unknown";
}

/* Which origins may use each site's navigator:
 *   ALLOWED_ORIGINS="acme=https://acme.com https://www.acme.com;blog=https://blog.acme.com"
 * Stops another website from embedding your site key and spending your quota
 * through its own visitors' browsers. It does NOT stop scripts: Origin is just a
 * header, and curl can send any value. Rate limits are what cover that.
 * Unset means every origin is allowed -- fine locally, warned about at startup.
 * Read per request, so it can change without a restart. */
function allowlist() {
  const raw = process.env.ALLOWED_ORIGINS?.trim();
  if (!raw) return null;
  const bySite = new Map<string, Set<string>>();
  for (const entry of raw.split(";")) {
    const [site, origins = ""] = entry.split("=");
    if (!site?.trim()) continue;
    bySite.set(
      site.trim(),
      new Set(origins.split(/[\s,]+/).filter(Boolean).map((o) => o.toLowerCase().replace(/\/$/, ""))),
    );
  }
  return bySite;
}

const originOf = (req: http.IncomingMessage) =>
  String(req.headers.origin ?? "").toLowerCase().replace(/\/$/, "");

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1e6) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
  });
}

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url!, "http://x");
  const origin = originOf(req);
  const allowed = allowlist();

  // /elements echoes back only an allowed origin; everything else is public.
  if (url.pathname === "/elements") {
    const known = !allowed || [...allowed.values()].some((set) => set.has(origin));
    if (known && origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-admin-key");
  if (req.method === "OPTIONS") return res.writeHead(204).end();

  try {
    // Opening the server root used to 404, which reads like a broken server.
    if (url.pathname === "/") {
      const sites = db
        .prepare(`SELECT site, COUNT(*) n FROM elements GROUP BY site ORDER BY site`)
        .all() as { site: string; n: number }[];
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(`<!doctype html><meta charset="utf-8">
<title>Website Navigator</title>
<style>body{font:15px/1.6 system-ui;margin:0;padding:40px;max-width:640px}
code{background:#eee;padding:2px 6px;border-radius:4px}
table{border-collapse:collapse;margin:12px 0}td{padding:4px 14px 4px 0}</style>
<h1>Website Navigator</h1>
<p>This is the API server, not a site. It serves
<code>/nav.js</code> and the element index at <code>GET /elements?site=...</code>.</p>
<h2>Indexed sites</h2>
${
        sites.length
          ? `<table>${sites
              .map((s) => `<tr><td><b>${s.site}</b></td><td>${s.n} elements</td></tr>`)
              .join("")}</table>`
          : "<p>None yet.</p>"
      }
<h2>Try it locally</h2>
<p>Serve a site folder with the widget already injected, and index it:</p>
<p><code>npm run dev -- ../finance-calculator-tools</code></p>`);
    }

    if (url.pathname === "/nav.js") {
      res.writeHead(200, {
        "content-type": "application/javascript",
        // Every visitor loads this on every page. Caching it for an hour cuts
        // repeat downloads, which is what a metered free tier bills for; the
        // cost is that a new widget version takes up to an hour to reach them.
        "cache-control": "public, max-age=3600",
      });
      // The scanner ships ahead of the widget: one file for the host site, one
      // definition of "interactive element" shared with the crawler.
      return res.end(
        readFileSync(new URL("./scan.js", import.meta.url), "utf8") +
          "\n" +
          readFileSync(new URL("./nav.js", import.meta.url), "utf8"),
      );
    }

    /* The index itself: every element the crawl found, with the chain that
     * reveals it. The widget filters and builds its steps from this -- one
     * request per page load, no per-question work on the server at all. */
    if (url.pathname === "/elements") {
      const ipWait = perIp(clientIp(req));
      if (ipWait) throw new RateLimited(ipWait, "Too many requests -- give it a minute.");
      const site = url.searchParams.get("site") ?? "";
      if (allowed && !allowed.get(site)?.has(origin)) {
        res.writeHead(403, { "content-type": "application/json" });
        return res.end(
          JSON.stringify({ error: `origin "${origin || "(none)"}" is not allowed for site "${site}"` }),
        );
      }
      const rows = getElements(site).map((e: El) => ({
        label: e.label, role: e.role, page: e.page, parent: e.parent,
      }));
      res.writeHead(200, {
        "content-type": "application/json",
        // Re-crawls are occasional; a visitor moving between pages shouldn't
        // re-download the same list each time.
        "cache-control": "public, max-age=300",
      });
      return res.end(JSON.stringify({ site, elements: rows }));
    }

    if (url.pathname === "/index" && req.method === "POST") {
      if (!ADMIN_KEY || req.headers["x-admin-key"] !== ADMIN_KEY) {
        res.writeHead(403, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "bad admin key" }));
      }
      const { site, url: start, auth } = await readBody(req);
      const { crawl } = await import("./crawl.ts");
      const out = await crawl(site, start, { storageState: auth });
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(out));
    }

    res.writeHead(404).end("not found");
  } catch (err) {
    if (err instanceof RateLimited) {
      // retryAfter goes in the body too: a cross-origin widget cannot read the
      // Retry-After header without an extra CORS expose.
      res.writeHead(429, {
        "content-type": "application/json",
        "retry-after": String(err.retryAfter),
      });
      return res.end(JSON.stringify({ error: err.message, retryAfter: err.retryAfter }));
    }
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
});

if (import.meta.filename === process.argv[1]) {
  server.listen(PORT, () => {
    console.log(`navigator on http://localhost:${PORT}`);
    if (!allowlist()) console.warn("ALLOWED_ORIGINS is not set: any website can use any site key.");
  });
  // As PID 1 in a container, Node ignores SIGTERM unless told otherwise, so
  // `docker stop` would wait out its 10s and then kill mid-request.
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      server.close(() => process.exit(0));
      server.closeAllConnections();
    });
  }
}
