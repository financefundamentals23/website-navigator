# Website Navigator

A `<script>` tag that lets visitors ask *"where is dark mode?"* and get the
buttons highlighted, in order, until they arrive.

![step 1](docs/step1.png)

## Why there is a crawler

A script in the browser can only see the page currently rendered — not your
routes, not your source, not a menu nobody has opened yet. So the site knowledge
is built **before** anyone asks: a Playwright crawl walks the site once, opens
menus, and records every interactive element and where it lives.

At query time that index plus the visitor's current screen goes to the model in
**one call**, which returns the whole path. The widget then runs the walkthrough
entirely on its own — no further network calls.

## Setup

```bash
npm install
npx playwright install chromium

# key from https://aistudio.google.com/apikey -- .env is gitignored, scripts load it
echo "LLM_API_KEY=AQ..." > .env
export NAV_ADMIN_KEY=$(openssl rand -hex 16)
```

The default model is **Gemini 3.5 Flash-Lite on the free tier** — $0, no card. The
site index is the bulk of every prompt, so the thing that matters most here is
context size, and Gemini's is large enough that no site outgrows it. Flash-Lite
also has the highest requests-per-minute of the free Google models.

Note that Google's free tier uses submitted data to improve their products. If
you're sending page digests of *customers'* sites, run a local model instead (see
below) — that's the reason the provider is configurable.

### Using a different provider

Any OpenAI-compatible endpoint works; it's env vars, not code:

```bash
# Groq — faster and smarter, but free-tier token/minute caps bite on large indexes
LLM_BASE_URL=https://api.groq.com/openai/v1  LLM_MODEL=llama-3.3-70b-versatile

# Ollama — nothing leaves the machine, no rate limits, no key
LLM_BASE_URL=http://localhost:11434/v1       LLM_MODEL=qwen3:14b

# OpenRouter — has a rotating set of :free models
LLM_BASE_URL=https://openrouter.ai/api/v1    LLM_MODEL=...:free
```

Whatever you point it at needs to honour `response_format: json_schema`. Ollama
does this with grammar-constrained decoding, which makes even a small local model
safe to use here.

Index the site (re-run after deploys that move navigation):

```bash
node crawl.ts acme https://acme.com
```

For anything behind a login, save a signed-in session once, then crawl with it:

```bash
node login.ts https://acme.com          # sign in in the window, press Enter
node crawl.ts acme https://acme.com --auth auth.json
```

The crawl then runs twice, signed out and signed in. Anything that only appears
signed in is marked, and a signed-out visitor asking for it is routed through
sign-in rather than told the feature doesn't exist. The crawler never follows
logout links.

`auth.json` is a live login: anyone holding it is signed in as that account.
It's gitignored. Use a test account, and re-run `login.ts` when the crawl
warns the session has expired. Sign-in providers that block automated browsers
(Google often does) need an email/password login for this.


Run the server, then drop the tag into the site:

```bash
node server.ts
```

```html
<script async src="https://your-server/nav.js" data-site="acme"></script>
```


## Running in Docker

```bash
docker build -t website-navigator .
docker run -d --name nav -p 8787:8787 --env-file .env -v navdata:/data website-navigator
```

The index and answer cache are one SQLite file at `/data/nav.db`, so **the
volume is not optional**: without it the database is wiped every time the
container is replaced, and every site has to be re-crawled. For the same
reason, run one instance. Two containers would each have their own database
and their own rate-limit counters.

Crawl from inside the running container:

```bash
docker exec -u node nav node crawl.ts finance-calculator-tools https://financefundamentals.app
```

Secrets come in at run time through `--env-file` and are never copied into
the image (`.dockerignore` excludes `.env` and `auth.json`). To crawl
signed in, mount the session file, e.g.
`-v $PWD/auth.json:/app/auth.json:ro`.

Run the tests in the same image, against a throwaway database so test sites
don't end up in the real one:

```bash
docker run --rm --env-file .env -e NAV_DB=/tmp/test.db website-navigator npm test
```

## Deploying to Google Cloud (free)

One always-free e2-micro VM running `compose.yml`, which is the navigator plus Caddy for HTTPS. Step by step in [docs/deploy-gcp.md](docs/deploy-gcp.md).

## Deploying to Railway

`railway.json` tells Railway to build the Dockerfile and health-check `/`.

1. Merge to `main`, then in Railway: **New Project → Deploy from GitHub repo**.
2. On the service, **add a volume mounted at `/data`**. Without it every
   deploy wipes the index. Keep one replica: Railway won't run replicas with a
   volume anyway, and the rate limits are per instance.
3. **Variables:**
   ```
   LLM_API_KEY=<AI Studio key>
   NAV_ADMIN_KEY=<long random string>
   TRUST_PROXY=1
   ALLOWED_ORIGINS=finance-calculator-tools=https://financefundamentals.app https://www.financefundamentals.app
   ```
   `TRUST_PROXY=1` is required here: behind Railway's proxy, every visitor
   otherwise shares one IP and one rate limit.
4. **Settings → Networking → Generate Domain.**
5. Index the site:
   ```bash
   curl -X POST https://<domain>/index -H "x-admin-key: $NAV_ADMIN_KEY" \
     -H "content-type: application/json" \
     -d '{"site":"finance-calculator-tools","url":"https://financefundamentals.app/"}'
   ```
   The crawl runs inside the request. Railway closes a request after 5 minutes
   with no data, which is plenty for a small site but not for a large one.
6. Add the script tag to your site, pointing at the new domain.

Railway mounts volumes owned by root. The container starts as root only long
enough to hand `/data` to the `node` user, then drops privileges, rather than
following Railway's documented workaround of running everything as root.

## Customising the launcher

By default you get a small circular help icon in the bottom-right corner. Every
part of that is yours to change.

### Put it where you want

```html
<script async src="https://your-server/nav.js" data-site="acme"
        data-position="bottom-left" data-offset="32px"></script>
```

`data-position` takes `bottom-right` (default), `bottom-left`, `top-right` or
`top-left`; `data-offset` is any CSS length.

### Or use your own button, anywhere in your markup

Point `data-trigger` at one of your own elements and ours is never rendered at
all — put the control in your nav bar, your footer, a menu, wherever it belongs:

```html
<button id="help">Need a hand?</button>
<script async src="https://your-server/nav.js" data-site="acme"
        data-trigger="#help"></script>
```

You can also open it from your own code: `window.navigator_widget.open()`, plus
`.close()`, `.ask("where is dark mode")` and `.stop()`.

### Style it from your own stylesheet

CSS custom properties cross the shadow boundary, so there is no theming API to
learn — set them on `:root` and they apply:

```css
:root {
  --wnav-accent: #132135;  /* button, spotlight ring and tooltip */
  --wnav-accent-2: #5cb6f9; /* far end of the panel's gradient */
  --wnav-bg:     #fff;     /* question panel background */
  --wnav-fg:     #1b1b1f;  /* question panel text */
  --wnav-size:   52px;     /* icon button size */
  --wnav-radius: 14px;     /* 50% for a circle, 0 for a square */
  --wnav-z:      2147483647;
}
```

### Wording

`data-label` sets the button's accessible name and tooltip, `data-placeholder`
the text in the question box. `data-title` sets the panel heading and `data-note` the
short note under it explaining that it only helps visitors find their way. The button is icon-only, so `data-label` is what
screen readers announce — keep it meaningful.

## If the server is down

The widget is built to be invisible when things go wrong: it never throws into
your page, and a request that hasn't answered in 8 seconds is abandoned with a
polite "try again" in its own panel. Load it with `async` (as in the snippets
above) so a slow or unreachable server can't delay your page either. Override
the wait with `data-timeout` in milliseconds.

It also tolerates being included twice, being placed in `<head>`, and browsers
that block `sessionStorage` — there, a walkthrough just can't carry across a
page load. If your site sends a strict CSP, add the navigator server to
`connect-src`.

## Allowed origins

Register which domains may use each site key, so another website can't embed
yours and spend your quota:

```bash
ALLOWED_ORIGINS="acme=https://acme.com https://www.acme.com;blog=https://blog.acme.com"
```

Anything else gets a 403. Unset, every origin is allowed and the server warns
at startup — fine locally, not in production. This stops other *websites*, not
scripts: `Origin` is just a header and curl can send anything. The rate limits
are what cover scripts.

## Rate limits

`POST /guide` answers 429 with a `Retry-After` once either limit is hit, and
the widget tells the visitor how long to wait.

| Variable | Default | Counts |
|---|---|---|
| `RATE_IP_PER_MIN` | 10 | every question from one IP, cached or not |
| `RATE_SITE_PER_MIN` | 60 | model calls for one site -- cache hits are free and never refused |
| `TRUST_PROXY` | off | set to `1` only behind a proxy you run, so the client IP comes from `X-Forwarded-For` |

Leave `TRUST_PROXY` off unless your own proxy sets that header: anyone can send
`X-Forwarded-For`, and trusting it lets them dodge the per-IP limit by
changing it on every request. Behind a proxy, though, it has to be on, or every
visitor shares the proxy's address and one limit.

The counters live in process memory, so the limits are per server instance.

## Cost and limits

One model call per *distinct* question per site. Answers are cached by question,
so the thousandth visitor asking about dark mode costs nothing, and the cache is
what keeps a free tier's rate limits comfortable. Cache is cleared whenever the
site is re-crawled.

Neither Google nor Groq publishes exact free-tier numbers in their docs any more —
both now defer to your account dashboard, so check there rather than trusting the
figures that circulate online.

On sites with more than 600 indexed elements the index is trimmed before the
prompt, keeping every menu opener and everything on the visitor's current page
(trimming by query words alone would drop the intermediate steps and break the
path).

## Tests

```bash
npm test
```

Spins up a demo site, crawls it, and drives the real widget in a real browser
through all three steps. Without credentials it stubs the model's answer so the
crawler and widget are still covered end to end.

## Limits

- **Crawl depth is one menu level.** A target nested two menus deep on the same
  page won't be indexed; it needs a recursive pass in `crawl.ts`.
- **Clicking is deliberately conservative.** The crawler only opens elements that
  declare themselves disclosures (`aria-haspopup`, `aria-expanded`, `<summary>`)
  or are labelled with a nav word. It will not click arbitrary buttons on your
  site, so a menu that looks like neither won't be opened.
- **The index goes stale.** When a step's label no longer resolves, the widget
  makes one recovery call with the live page and retries. Re-crawl on deploy.
- **Destructive actions are fenced off.** The model is instructed never to route
  someone to a delete/deactivate/reset control unless they asked for that exact
  action — without it, "cancel my subscription" confidently pointed at "Delete
  account". Re-check this if you change the system prompt.
- **A model can invent labels.** A JSON schema guarantees the shape of the reply,
  not its truth. The server drops any step naming something absent from both the
  index and the live page, and lowers confidence when it does — this is what makes
  a smaller free model safe to use. Watch the `dropped N invented step(s)` warnings
  in the server log; frequent ones mean the model is too weak or the index is stale.
- **Label matching is case-insensitive substring**, so non-English sites and
  icon-only controls without `aria-label` will match poorly.
