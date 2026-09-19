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
- Only emit steps for things that exist in the index or on the current page.
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

const asTsv = (rows: El[]) =>
  `page\tlabel\trole\tinside_menu\n` +
  rows.map((r) => [r.page, r.label, r.role, r.parent].join("\t")).join("\n");

async function guide(body: any) {
  const site = String(body.site ?? "");
  const query = String(body.query ?? "").slice(0, 300);
  if (!site || !query) throw new Error("site and query are required");

  const key = norm(query);
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

  const live = (body.digest ?? []).slice(0, 200);
  const digest = live.map((d: any) => `${d.label}\t${d.role}`).join("\n");

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
  if (out.steps.length < before) {
    out.confidence = Math.min(out.confidence ?? 0, 0.3);
    console.warn(`[guide] dropped ${before - out.steps.length} invented step(s) for "${query}"`);
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
  // The widget runs on the customer's origin, so every call here is cross-origin.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-admin-key");
  if (req.method === "OPTIONS") return res.writeHead(204).end();

  const url = new URL(req.url!, "http://x");

  try {
    if (url.pathname === "/nav.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      return res.end(readFileSync(new URL("./nav.js", import.meta.url), "utf8"));
    }

    if (url.pathname === "/guide" && req.method === "POST") {
      const out = await guide(await readBody(req));
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
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
});

if (import.meta.filename === process.argv[1]) {
  server.listen(PORT, () => console.log(`navigator on http://localhost:${PORT}`));
}
