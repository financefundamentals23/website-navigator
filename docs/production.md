# Production readiness

Current state: a working prototype, verified end to end against a real site. It
is **not** production-ready, and this is the gap.

Ordered by what actually blocks a launch.

---

## 1. Blockers

### The `/guide` endpoint is open to the world

Anyone who reads your page source gets your endpoint and your `data-site`, and
can then spend your model quota in a loop. There is no auth, no rate limit and
no origin check.

- Per-site public key, and check `Origin` against a registered allowlist.
- Rate limit per IP and per site. A visitor asking more than ~10 questions a
  minute is not a visitor.
- Cap spend per site per day; fail closed to a friendly "try again later".

The answer cache absorbs honest traffic, so limits can be tight. Abuse is
specifically *cache-miss* traffic — bill and limit on misses, not requests.

### Index freshness

The index is a snapshot. Ship a redesign and every stored label can be wrong,
which the widget only discovers one visitor at a time, six seconds each.

- Re-crawl on deploy (CI step hitting `POST /index`).
- Track the recovery-call rate per site. A rising rate *is* the staleness alarm.
- Version the index; keep the previous one and roll back if recovery spikes.

### It fails loudly inside someone else's page

If the API is down the widget logs and shows an error. It must never throw into
the host page or block rendering.

- Load the script `async`; never touch the host DOM before first interaction.
- Wrap init in try/catch — a broken widget must be invisible, not a broken site.
- Timeout on `/guide` (5s) and fail silently closed.
- Document the `connect-src` entry sites need if they run a strict CSP.

### Auth-gated pages are a correctness problem, not a coverage one

Verified on a real site: logged out, the crawler could not see the profile form
and the model confidently answered *"the site does not have a saved income
setting"* — which is false. A wrong answer is worse than no answer.

- Crawl with `--auth` for any site with a signed-in area.
- Mark index rows as auth-gated; if the visitor is signed out, say "sign in
  first" rather than routing them into a wall.

---

## 2. Correctness and trust

- **The `answer` sentence is unvalidated.** Steps are checked against the index;
  the prose is not, and it has invented a "FAQ section on the home page" that
  does not exist. Either validate it or stop showing free text.
- **Disabled targets.** Spotlighting a greyed-out control is a dead end.
  `isDisabled` exists in `scan.js` and is unused.
- **Low confidence is not surfaced.** Below ~0.4 the widget should offer search
  or support instead of guiding confidently into a guess.
- **Destructive-action guard is a prompt rule**, so it holds most of the time,
  not every time. If real users hit this, move it into code: a denylist applied
  server-side unless the query contains the matching verb.

---

## 3. Privacy and legal

- **The digest leaves the visitor's browser.** Labels only, capped at 200 — but
  a label can contain a name or an order number. Strip anything digit-heavy
  before sending, and say so in the host's privacy policy.
- **Queries are stored** as cache keys, and a question can be personal. Put a
  retention window on the `answers` table.
- **Free-tier model terms.** Google's free tier uses submitted data to improve
  their products. For customer sites that likely means paying for the API, or
  self-hosting — which the OpenAI-compatible adapter already allows.
- **robots.txt is honoured** as of this branch, and the crawler identifies as a
  stock browser. Give it an honest UA string before pointing it anywhere you
  don't own.

---

## 4. Scale

- **Index size.** The whole index goes into the prompt, trimmed to 600 rows. A
  large site blows past that, and the trim is keyword overlap plus every menu
  opener. Past a few thousand elements this needs embeddings and retrieval.
- **Crawl time.** Roughly 110s for 6 pages of a heavy site. A 500-page site is
  hours. Needs parallel contexts, and incremental re-crawl of changed routes.
- **One SQLite file.** Fine for tens of sites. Beyond that it is the bottleneck,
  and `clearSite` + re-insert is a write-lock pause.
- **`nav.js` is served uncompressed and unversioned.** Fingerprint it, cache it
  hard, gzip it, and pin an SRI hash.

---

## 5. Observability

This is the part that turns it into a product rather than a demo. Every query is
a user telling you what they could not find.

Log per query: site, normalised question, cache hit, confidence, step count,
invented steps dropped, recovery calls, and whether the visitor finished the
walkthrough or abandoned it.

Three reports fall straight out of that:

- **Questions with no answer** — the site is missing a feature, or hiding one.
- **Paths abandoned mid-walkthrough** — the route is too long or the labels lie.
- **Rising recovery rate** — the index is stale.

The first of those is worth more to a site owner than the widget itself.

---

## 6. Testing

Present: 10 end-to-end checks and a 31/34 element-coverage report, both runnable
offline apart from one live model call.

Missing before launch:

- A path-quality eval: a fixed set of question → expected-path pairs per site,
  scored on every prompt or model change. Prompt edits are currently unmeasured
  beyond "I ran it three times".
- Cross-browser (Safari and Firefox; only Chromium is exercised).
- Mobile: the spotlight and tooltip have never been tested on a touch device.
- Load: concurrent `/guide` with a cold cache.
