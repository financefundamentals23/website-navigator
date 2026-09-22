# Website Navigator

A `<script>` tag that gives visitors a **Where is** box: they pick something from
a list of everything on your site, and the buttons are highlighted, in order,
until they arrive.

![step 1](docs/step1.png)

## Why there is a crawler

A script in the browser can only see the page currently rendered — not your
routes, not your source, not a menu nobody has opened yet. So the site knowledge
is built **before** anyone asks: a Playwright crawl walks the site once, opens
menus, and records every interactive element and where it lives.

The widget downloads that index once per page load and does the rest itself:
filtering as the visitor types, and following each element's recorded parent
chain to build the clicks that reveal it. No model, no per-question cost, and
nothing to time out.

## Setup

```bash
npm install
npx playwright install chromium

export NAV_ADMIN_KEY=$(openssl rand -hex 16)
```

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

`GET /elements` answers 429 with a `Retry-After` once the limit is hit. The
widget downloads the index once per page load, so a visitor never comes close.

| Variable | Default | Counts |
|---|---|---|
| `RATE_IP_PER_MIN` | 10 | index downloads from one IP |
| `TRUST_PROXY` | off | set to `1` only behind a proxy you run, so the client IP comes from `X-Forwarded-For` |

Leave `TRUST_PROXY` off unless your own proxy sets that header: anyone can send
`X-Forwarded-For`, and trusting it lets them dodge the per-IP limit by
changing it on every request. Behind a proxy, though, it has to be on, or every
visitor shares the proxy's address and one limit.

The counters live in process memory, so the limits are per server instance.

## Cost

Nothing per question: the only request is one index download per page load,
served from SQLite. The crawl is the only expensive thing, and you run it when
the site changes.

## Tests

```bash
npm test
```

Spins up a demo site, crawls it, and drives the real widget in a real browser:
picking from the list, following a link to another page, waiting for a menu to
open, and recovering when what was picked has moved.

## Limits

- **Crawl depth is one menu level.** A target nested two menus deep on the same
  page won't be indexed; it needs a recursive pass in `crawl.ts`.
- **Clicking is deliberately conservative.** The crawler only opens elements that
  declare themselves disclosures (`aria-haspopup`, `aria-expanded`, `<summary>`)
  or are labelled with a nav word. It will not click arbitrary buttons on your
  site, so a menu that looks like neither won't be opened.
- **The index goes stale.** When what was picked no longer resolves on the page,
  the widget says so and reopens the list. Re-crawl on deploy.
- **The list only offers what the crawl found.** A visitor looking for something
  by a word your site never shows them won't find it: the entries are your own
  labels, not synonyms.
- **Label matching is case-insensitive substring**, so non-English sites and
  icon-only controls without `aria-label` will match poorly.
