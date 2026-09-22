# Production readiness

Current state: a working prototype, verified end to end against a real site. It
is **not** production-ready, and this is the gap.

Ordered by what actually blocks a launch.

---

## 1. Blockers

### The `/elements` endpoint is open to the world

Anyone who reads your page source gets your endpoint and your `data-site`, and
can then download your whole index in a loop. Since the model went away there is
no per-request cost behind it, so this is bandwidth and disclosure, not spend.

- ~~Check `Origin` against a registered allowlist.~~ **Done** — `ALLOWED_ORIGINS`, per site.
- ~~Rate limit per IP.~~ **Done.** 10 index downloads/min per IP, 429 with
  Retry-After. In-process memory: per instance, so it needs Redis before running
  more than one.
- The index is a map of your site's UI. It is no more secret than the pages it
  was built from, but a signed-in crawl puts signed-in-only labels in it — worth
  splitting those out before serving them to anonymous visitors.

### Index freshness

The index is a snapshot. Ship a redesign and every stored label can be wrong,
which the widget only discovers one visitor at a time, six seconds each.

- Re-crawl on deploy (CI step hitting `POST /index`).
- Track the recovery-call rate per site. A rising rate *is* the staleness alarm.
- Version the index; keep the previous one and roll back if recovery spikes.

### ~~It fails loudly inside someone else's page~~ — done

If the API is down the widget logs and shows an error. It must never throw into
the host page or block rendering.

- Load the script `async`; never touch the host DOM before first interaction.
- Wrap init in try/catch — a broken widget must be invisible, not a broken site.
- Timeout on `/elements` and fail silently closed.
- Document the `connect-src` entry sites need if they run a strict CSP.

### ~~Auth-gated pages are a correctness problem~~ — done (`login.ts` + two-pass crawl)

Verified on a real site: logged out, the crawler could not see the profile form,
so nothing behind the login was listed at all — the visitor is told the site
does not have it, which is false.

- Crawl with `--auth` for any site with a signed-in area.
- Index rows are marked as auth-gated. The list does not yet use that mark: a
  signed-out visitor can pick something they cannot reach, and only finds out
  when the walkthrough stalls.

---

## 2. Correctness and trust

- **Disabled targets.** Spotlighting a greyed-out control is a dead end.
  `isDisabled` exists in `scan.js` and is unused.
- **Destructive entries are listed like any other.** "Delete account" is in the
  index, so it is in the list. Nothing is clicked for the visitor, but consider
  excluding destructive labels from the picker.
- **Every page's entries are offered everywhere**, so a pick often starts with a
  trip to another page. Grouping the list by page, or putting this page first,
  would make that obvious before the visitor commits.

---

## 3. Privacy and legal

- **Nothing about the visitor leaves their browser any more.** No question, no
  page digest, no third party: the widget downloads the index and does the rest
  locally. What the crawl recorded is the only data held.
- **A crawled label can carry personal data** — a saved calculation named after
  someone, an order number. That goes into the index and is served to every
  visitor of that site. Worth filtering digit-heavy labels at crawl time.
- **robots.txt is honoured** as of this branch, and the crawler identifies as a
  stock browser. Give it an honest UA string before pointing it anywhere you
  don't own.

---

## 4. Scale

- **Index size.** The whole index is downloaded by the widget (~6KB for 160
  elements). A few thousand elements is still fine gzipped; past that, the list
  needs server-side filtering rather than shipping everything.
- **Crawl time.** Roughly 110s for 6 pages of a heavy site. A 500-page site is
  hours. Needs parallel contexts, and incremental re-crawl of changed routes.
- **One SQLite file.** Fine for tens of sites. Beyond that it is the bottleneck,
  and `clearSite` + re-insert is a write-lock pause.
- **`nav.js` is served uncompressed and unversioned.** Fingerprint it, cache it
  hard, gzip it, and pin an SRI hash.

---

## 5. Observability

This is the part that turns it into a product rather than a demo. Every pick is
a user telling you what they could not find on their own — and every search that
matched nothing is worth more still.

That now happens in the visitor's browser, so it has to be sent back
deliberately: what was typed, what was picked, whether anything matched, and
whether the walkthrough finished or was abandoned.

Three reports fall straight out of that:

- **Searches that matched nothing** — the site is missing a feature, or calls it something nobody types.
- **Paths abandoned mid-walkthrough** — the route is too long or the labels lie.
- **Rising recovery rate** — the index is stale.

The first of those is worth more to a site owner than the widget itself.

---

## 6. Testing

Present: 12 end-to-end checks and an element-coverage report, all runnable
offline — there is no external service left to reach.

Missing before launch:

- Cross-browser (Safari and Firefox; only Chromium is exercised).
- Mobile: the spotlight and tooltip have never been tested on a touch device.
- Load: concurrent `/elements` downloads on a large index.
