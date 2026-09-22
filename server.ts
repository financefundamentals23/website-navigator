import http from "node:http";
import { readFileSync } from "node:fs";
import { db, getElements, type El } from "./db.ts";

const PORT = Number(process.env.PORT ?? 8787);
const ADMIN_KEY = process.env.NAV_ADMIN_KEY ?? "";

/* Any OpenAI-compatible endpoint works -- switching provider is env vars, not code.
 *   Gemini free tier (default):  LLM_API_KEY=<AI Studio key>
 *   Groq:      LLM_BASE_URL=https://api.groq.com/openai/v1  LLM_MODEL=llama-3.3-70b-versatile
 *   Ollama:    LLM_BASE_URL=http://localhost:11434/v1       LLM_MODEL=qwen3:14b
 *   OpenRouter LLM_BASE_URL=https://openrouter.ai/api/v1    LLM_MODEL=...:free           */
const llm = () => ({
  base: (process.env.LLM_BASE_URL ??
    "https://generativelanguage.googleapis.com/v1beta/openai").replace(/\/$/, ""),
  model: process.env.LLM_MODEL ?? "gemini-3.5-flash-lite",
  key: process.env.LLM_API_KEY ?? process.env.GEMINI_API_KEY ?? "no-key-needed",
});

async function complete(system: string, user: string, schema: object) {
  const LLM = llm();
  const r = await fetch(`${LLM.base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${LLM.key}` },
    body: JSON.stringify({
      model: LLM.model,
      temperature: 0, // picking from a list; sampling only invents labels
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "guide", strict: true, schema },
      },
    }),
  });
  if (!r.ok) throw new Error(`${LLM.model} returned ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const body = (await r.json()) as any;
  const text = body.choices?.[0]?.message?.content;
  if (!text) throw new Error("model returned no content");
  return JSON.parse(text);
}

/* Rate limits. Two different jobs:
 *   per IP   -- a visitor asking more than ~10 questions a minute is not a visitor.
 *               Counts every /guide call, cached or not.
 *   per site -- caps model calls (cache misses) for one site, since misses are
 *               what spend quota. Stops one busy or abused site draining it all.
 * Limits are read per call so they can be tuned without a restart.
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
const perSite = limiter(() => Number(process.env.RATE_SITE_PER_MIN ?? 60));

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

const SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string", description: "One short sentence for the user." },
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string", description: "Visible text or aria-label of the thing to click, copied exactly." },
          role: { type: "string" },
          page: { type: "string", description: "Path this element is on." },
          hint: { type: "string", description: "Short instruction, e.g. 'Open the settings menu'." },
        },
        required: ["label", "role", "page", "hint"],
        additionalProperties: false,
      },
    },
    confidence: { type: "number", description: "0-1. Below 0.4 means you are guessing." },
  },
  required: ["answer", "steps", "confidence"],
  additionalProperties: false,
} as const;

const SYSTEM = `You help website visitors find things. You are given an index of every
interactive element on a site (built by crawling it), plus what is currently on the
visitor's screen, plus their question.

Return the ordered clicks that take them from where they are to what they asked for.

Rules:
- Copy labels EXACTLY as they appear in the index or the current page. The widget finds
  elements by matching this text, so an invented or paraphrased label matches nothing.
- If an element has a parent, the parent must be clicked first: emit it as its own step.
- If the target is on another page, the first step is the link or nav item leading there.
- The LAST step must be the thing the visitor actually asked for, not merely the page
  or section that contains it. Stopping at "go to the calculators page" is not an
  answer; keep going until the final step is the control itself.
- Only emit steps for things that exist in the index or on the current page.
- Rows marked signed_in_only exist only for signed-in visitors. If the visitor's
  current page shows a sign-in control, they are signed out: make that sign-in
  control the first step, then continue the path as usual, still ending on what
  they asked for. Say in answer that they will need to sign in. Never claim the
  site lacks a feature just because it is signed_in_only.
- If the site genuinely has no such feature, return an empty steps array, say so in
  answer, and set confidence low.
- NEVER route someone to a destructive or irreversible action (delete, remove, close,
  deactivate, reset, cancel an account) unless they explicitly asked for that exact
  action. "Cancel my subscription" is not permission to highlight "Delete account".
  If the nearest match is destructive and they did not ask for it, return no steps
  and say in answer what the site does offer instead.`;

const norm = (q: string) =>
  q.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

const MAX_ROWS = 600;

/* On a big site the index is most of the prompt, and free tiers meter tokens per
 * minute. Trim it -- but never by query words alone: "where is dark mode" doesn't
 * contain "Settings", and dropping the intermediate step breaks the whole path.
 * So keep every menu opener and everything on the page the visitor is standing on,
 * then fill the rest with query matches. */
function relevantIndex(site: string, query: string, here: string) {
  const rows = getElements(site);
  if (rows.length <= MAX_ROWS) return rows;

  const openers = new Set(rows.map((r) => r.parent).filter(Boolean));
  const words = norm(query).split(" ").filter((w) => w.length > 2);
  const hits = (r: El) =>
    words.filter((w) => `${r.label} ${r.page} ${r.parent}`.toLowerCase().includes(w)).length;

  const keep: El[] = [];
  const rest: El[] = [];
  for (const r of rows) {
    if (openers.has(r.label) || r.page === here || hits(r)) keep.push(r);
    else rest.push(r);
  }
  return keep.length >= MAX_ROWS
    ? keep.slice(0, MAX_ROWS)
    : keep.concat(rest.slice(0, MAX_ROWS - keep.length));
}

/* Menus nest: a button inside a collapsed panel inside an inactive tab. The index
 * stores one parent per element, so walk the links to get the whole chain. */
function ancestry(rows: El[]) {
  // Keyed case-insensitively: the same control can be recorded as "Saved Items"
  // in one place and "SAVED ITEMS" in another (CSS text-transform reaches
  // innerText), and an exact-match chain silently breaks on that.
  const k = (page: string, label: string) => `${page}|${label.toLowerCase().trim()}`;
  const parentOf = new Map<string, string>();
  for (const r of rows) if (r.parent) parentOf.set(k(r.page, r.label), r.parent);

  return (page: string, label: string) => {
    const chain: string[] = [];
    const seen = new Set<string>();
    let cur = parentOf.get(k(page, label));
    while (cur && !seen.has(cur.toLowerCase())) {
      seen.add(cur.toLowerCase());
      chain.unshift(cur);
      cur = parentOf.get(k(page, cur));
    }
    return chain;
  };
}

// Hand the model the resolved chain rather than making it join rows itself.
const asTsv = (rows: El[]) => {
  const chainOf = ancestry(rows);
  return (
    `page\tlabel\trole\topen_these_first\tsigned_in_only\n` +
    rows
      .map((r) =>
        [r.page, r.label, r.role, chainOf(r.page, r.label).join(" > "), r.auth ? "yes" : ""].join("\t"),
      )
      .join("\n")
  );
};

// A step can tell a signed-out visitor to sign in first; that step is baked into
// the cached answer. Caching it under the bare question would then hand a
// signed-in visitor the exact same "sign in first" instruction forever -- the
// cache never sees their session, only whatever the first asker's screen showed.
// So split the cache in two: whether the asker's own screen currently shows a
// sign-in control.
const SIGNED_OUT_RE = /\bsign[\s-]?(in|up)\b|\blog[\s-]?(in|on)\b/i;
const looksSignedOut = (digest: any[]) =>
  digest.some((d) => SIGNED_OUT_RE.test(String(d?.label ?? "")));

async function guide(body: any) {
  const site = String(body.site ?? "");
  const query = String(body.query ?? "").slice(0, 300);
  if (!site || !query) throw new Error("site and query are required");

  const live = (body.digest ?? []).slice(0, 200);
  const key = norm(query) + (looksSignedOut(live) ? "\u0000out" : "");
  if (!body.noCache) {
    const hit = db
      .prepare(`SELECT json FROM answers WHERE site = ? AND q = ?`)
      .get(site, key) as { json: string } | undefined;
    // Cached by question, not by page: the answer is a path through the site, and
    // "where is dark mode" gets asked far more often than the site changes.
    if (hit) return { ...JSON.parse(hit.json), cached: true };
  }

  const here = String(body.url ?? "/");
  const rows = relevantIndex(site, query, here);
  if (!rows.length) throw new Error(`no index for site "${site}" -- run the crawler first`);

  const digest = live.map((d: any) => `${d.label}\t${d.role}`).join("\n");

  // Checked here, after the cache and the index lookup: only a real model call counts.
  const siteWait = perSite(site);
  if (siteWait) throw new RateLimited(siteWait, "This site is getting a lot of questions right now.");

  const out = await complete(
    SYSTEM,
    `SITE INDEX:\n${asTsv(rows)}\n\nVISITOR IS ON: ${here}\nVISIBLE RIGHT NOW (label, role):\n${digest}\n\nQUESTION: ${query}`,
    SCHEMA,
  );
  if (!Array.isArray(out.steps)) throw new Error("model returned no steps array");

  /* A JSON schema guarantees the shape, not the truth: nothing stops a model
   * inventing a label that isn't on the site, and the widget would then hunt for
   * six seconds and waste its one recovery call. Only ship steps that name
   * something we actually saw. (Near-misses in case or spacing are fine -- the
   * widget matches labels case-insensitively.) */
  const known = new Set(
    [...rows.map((r) => r.label), ...live.map((d: any) => String(d.label ?? ""))].map((l) =>
      l.toLowerCase().trim(),
    ),
  );
  const before = out.steps.length;
  out.steps = out.steps.filter((s: any) => known.has(String(s.label ?? "").toLowerCase().trim()));
  const kept = out.steps.length; // count before expansion, or the check below lies

  /* Put back the steps the model skipped. It reliably names the destination and
   * just as reliably forgets the tab and the collapsed panel standing in front of
   * it -- and a step whose target is still hidden strands the visitor. The index
   * knows what has to be opened first, so insert those rather than ask nicely. */
  const chainOf = ancestry(rows);
  const byLabel = new Map(rows.map((r) => [`${r.page}|${r.label.toLowerCase().trim()}`, r]));

  /* Never trust the model's `page`. Observed values include " /", "/*" and
   * `["\"\"]`, and since the ancestor lookup is keyed on page, junk there made the
   * inserted steps vanish at random. The index already knows where each label
   * lives, so read it from there and only fall back for live-page-only labels. */
  const pagesOf = new Map<string, string[]>();
  for (const r of rows) {
    const k = r.label.toLowerCase();
    if (!pagesOf.has(k)) pagesOf.set(k, []);
    if (!pagesOf.get(k)!.includes(r.page)) pagesOf.get(k)!.push(r.page);
  }
  const pageFor = (label: string, claimed: unknown) => {
    const c = String(claimed ?? "").trim();
    const known = pagesOf.get(label.toLowerCase());
    if (known) {
      /* The same label can live on several pages -- "Liquid savings (S)" is on
       * both the calculator and the profile. Picking the first one seen sent a
       * visitor to the wrong page, so use the model's claim when it names one of
       * them, then the page the visitor is on, and only then the first. */
      if (known.includes(c)) return c;
      if (known.includes(here)) return here;
      return known[0];
    }
    return /^\/[\w\-/.]*$/.test(c) ? c : here;
  };

  const expanded: any[] = [];
  for (const s of out.steps) {
    const page = pageFor(String(s.label ?? "").trim(), s.page);
    for (const parent of chainOf(page, String(s.label ?? "").trim())) {
      if (expanded.some((e) => e.label.toLowerCase() === parent.toLowerCase())) continue;
      const row = byLabel.get(`${page}|${parent.toLowerCase().trim()}`);
      expanded.push({
        // the index spelling is what the widget matches against the live DOM
        label: row?.label ?? parent,
        role: row?.role ?? "button",
        page,
        hint: `Open "${parent}"`,
      });
    }
    expanded.push({ ...s, page });
  }
  out.steps = expanded;

  if (kept < before) {
    out.confidence = Math.min(out.confidence ?? 0, 0.3);
    console.warn(`[guide] dropped ${before - kept} invented step(s) for "${query}"`);
    if (!out.steps.length) out.answer = "I couldn't find that on this site.";
  }

  db.prepare(
    `INSERT OR REPLACE INTO answers (site, q, json, created) VALUES (?, ?, ?, ?)`,
  ).run(site, key, JSON.stringify(out), Date.now());

  return { ...out, cached: false };
}

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

  // /guide echoes back only an allowed origin; everything else is public.
  if (url.pathname === "/guide") {
    // The preflight carries no body, so no site: pass any origin listed for any
    // site, and let the POST itself check the specific one.
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
<code>/nav.js</code> and answers <code>POST /guide</code>.</p>
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

    if (url.pathname === "/guide" && req.method === "POST") {
      // Before reading the body: a flood should cost us as little as possible.
      const ipWait = perIp(clientIp(req));
      if (ipWait) throw new RateLimited(ipWait, "Too many questions -- give it a minute.");
      const body = await readBody(req);
      if (allowed && !allowed.get(String(body.site ?? ""))?.has(origin)) {
        res.writeHead(403, { "content-type": "application/json" });
        return res.end(
          JSON.stringify({ error: `origin "${origin || "(none)"}" is not allowed for site "${body.site}"` }),
        );
      }
      const out = await guide(body);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(out));
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
