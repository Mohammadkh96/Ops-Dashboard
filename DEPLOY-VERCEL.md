# Running all of OpsOS on Vercel

Both halves — dashboard and API — deploy to Vercel as **two projects from this
one repository**, distinguished by their Root Directory.

| Vercel project | Root Directory | Serves | Suggested domain |
|---|---|---|---|
| `opsos-web` | *(repo root)* | the dashboard (static export) | `ops.dashboard.tradin.com` |
| `opsos-api` | `apps/api` | the NestJS API + webhook receiver | `api.dashboard.tradin.com` |

They are separate projects because they build differently — one produces static
files, the other a serverless function. A single project cannot do both.

**Nothing about your existing Paymaxis → CRM integration changes.** The CRM's
webhook URL stays exactly as it is.

---

## What had to change, and why

Vercel discards the process between requests. Three things assumed it would not:

**The live feed.** `/api/dashboard/stream` (SSE) holds a connection open and
pushes each payment down it. No serverless invocation lives long enough. It is
still there and still works on an always-on host, but the dashboard now defaults
to `GET /api/dashboard/feed` — the same events, read from Postgres, polled every
4 seconds with a cursor so nothing is missed or repeated.

Reading from the database rather than from memory also fixes something the stream
could never have done here: the webhook that receives a payment and the request
that serves the dashboard run in *different processes*, so the in-memory `LiveBus`
can never carry an event between them. Committed rows can.

The cursor is `receivedAt|id`, not just a timestamp, because two callbacks can
land in the same millisecond — a timestamp-only cursor would either skip one of
them or replay it forever.

**The poller's timer.** `PaymaxisService` used `setInterval`. On Vercel that
timer dies with the invocation that created it, so the schedule now comes from
outside: a cron entry in `apps/api/vercel.json` calls `GET /api/paymaxis/sync`.

**The poll watermark.** It lived in a `Map`, which starts empty on every cold
start — each run would re-read the whole look-back window instead of only what
changed. It is now a `PollWatermark` row.

One more, less obvious: **the database pool**. Prisma's default pool holds 10
connections. Twenty concurrent instances would ask for 200 and exhaust a server
that allows ~100. On Vercel each instance now takes exactly one.

---

## 1. A database

You need Postgres with a **pooled** connection string — Neon, Supabase (use the
*transaction pooler* URL), or Vercel Postgres. A direct connection string will
work in testing and fall over under load.

Apply the schema once, from your machine:

```bash
cd apps/api
DATABASE_URL="<the pooled url>" npx prisma migrate deploy
```

## 2. The API project

New Vercel project → import this repo → **Root Directory: `apps/api`**.

Turn on **Include source files outside of the Root Directory** in the project's
build settings. The install step runs at the repo root because that is where the
npm-workspaces lockfile lives.

Everything else comes from `apps/api/vercel.json` — build command, the rewrite
that sends every path into Nest, `maxDuration`, and the cron entry.

### Environment variables

**Every secret in OpsOS lives in this project and nowhere else.** The dashboard
project below gets three non-secret values and no credentials at all — see the
warning there for why that is not a matter of tidiness.

Set all of these for **Production, Preview and Development** unless a line says
otherwise, and add them through Vercel's UI. None of them belong in a file in
the repo.

Vercel reads environment variables at **build** time as well as run time, and a
change to any of them only takes effect on a **new deployment**. Adding a
variable to a project that is already deployed does nothing until you redeploy.

#### Required — the API will not work without these

```ini
# Neon, the POOLED connection string (the one with -pooler in the host).
DATABASE_URL="<pooled postgres url>"

# Signs the session token every logged-in browser carries. Anyone holding this
# can mint a token for any account, including ADMIN, without a password.
#   node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
JWT_SECRET="<random string>"

# Encrypts PSP credentials before they are written to the database.
# Generate ONCE and never change it: every provider key stored under the old
# value becomes permanently unreadable and all 11 terminals must be re-entered.
#   node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
CREDENTIALS_KEY="<random string>"

# Which browser origin may call this API (CORS). The dashboard's address, with
# no trailing slash. Wrong here reads as "the API is down" in the browser.
WEB_ORIGIN="https://ops.dashboard.tradin.com"

# This API's own public address. Google's redirect URI is derived from it.
API_PUBLIC_URL="https://api.dashboard.tradin.com"
```

#### Required — live payment data

```ini
# Webhook verification. One signing key per shop; each shop signs with its own.
PAYMAXIS_SIGNING_KEYS="5141=<mauritius key>,6321=<saint lucia key>"

# Read-only polling. shopId:apiKey pairs.
PAYMAXIS_SHOPS="5141:<key>,6321:<key>"
PAYMAXIS_POLL_ENABLED="1"

# Vercel sends this back as `Authorization: Bearer <value>` on cron invocations.
CRON_SECRET="<random string>"

# Never 1 in production — while it is on, anyone who finds the webhook URL can
# inject events.
PAYMAXIS_WEBHOOK_CAPTURE="0"
# The simulator stands down on the first real event anyway; this is belt and
# braces so a live dashboard can never show invented rows.
LIVE_SIMULATE="false"
```

#### Optional — Google sign-in

Leave these unset and the login page shows only the email/password form. It asks
the API which providers exist rather than guessing, so an unconfigured
deployment never shows a button that leads nowhere.

```ini
GOOGLE_CLIENT_ID="<from Google Cloud Console>"
GOOGLE_CLIENT_SECRET="<from Google Cloud Console>"
# Blank REFUSES every sign-in — there is deliberately no "empty means everyone".
GOOGLE_ALLOWED_DOMAINS="tradin.com"
GOOGLE_DEFAULT_ROLE="READ_ONLY"
```

#### Optional — sending the handover email

```ini
GMAIL_REFRESH_TOKEN="<from scripts/gmail-authorize.mjs>"
GMAIL_SENDER="ops@tradin.com"
MAIL_FROM="OpsOS <ops@tradin.com>"
```

Without these the handover is still written, read and acknowledged in the
dashboard; only the emailed copy is skipped.

#### Not needed on Vercel

`PORT` (Vercel assigns it), `REDIS_URL` (unused on serverless),
`SHADOW_DATABASE_URL` (only for authoring migrations locally), and the whole
`PAYMAXIS_BASE_URL` / `_PATH` / `_PARAM` block — those defaults were confirmed
against the live API and setting them by hand is how they get set wrong.

Check it: `GET https://<api domain>/api/health` → `{"status":"ok","database":"up"}`.

## 3. The dashboard project

Your existing Vercel project, unchanged. Add one variable:

```ini
NEXT_PUBLIC_API_URL = https://api.dashboard.tradin.com/api
```

Then **redeploy** — `NEXT_PUBLIC_` values are compiled into the JavaScript at
build time, so an existing deployment will not pick it up until it rebuilds.

Optional:

```ini
NEXT_PUBLIC_LIVE_POLL_MS = 4000    # feed poll interval; default 4000
NEXT_PUBLIC_LIVE_TRANSPORT = sse   # only if the API is on an always-on host
```

> **Never put a secret in this project.** Not a Paymaxis key, not
> `DATABASE_URL`, not `CREDENTIALS_KEY` — and in particular never as a
> `NEXT_PUBLIC_` variable. This app is a **static export**: `NEXT_PUBLIC_` values
> are not read on a server at request time, they are **compiled into the
> JavaScript files served to every visitor**. Anyone who opens the site can read
> them with View Source, and they stay readable in the browser cache and in
> Vercel's deployment history after the variable is deleted. A key that reaches
> this project has to be treated as published and rotated at the provider.
>
> The dashboard never talks to a payment provider. It calls the API, the API
> holds the keys. That is the whole reason the two projects are separate.

## 4. Custom domains

Both projects are on Vercel, so both records are the same kind:

```
ops.dashboard    CNAME   cname.vercel-dns.com.
api.dashboard    CNAME   cname.vercel-dns.com.
```

New names on unused subdomains: nothing about `my.tradin.com` or
`global.tradin.com` is read or modified, and there are no A records to touch.

If `tradin.com` sits behind Cloudflare with the proxy on, note that free
Universal SSL covers `*.tradin.com` but **not** a three-label name like
`ops.dashboard.tradin.com`. Either set both records to DNS-only (grey cloud), or
use two-label names (`ops.tradin.com`, `ops-api.tradin.com`).

---

## Using the Paymaxis API keys

The read API has been probed and the defaults are already correct, so only the
keys are needed:

```ini
PAYMAXIS_SHOPS="5141:<key>,6321:<key>"   # shopId:apiKey
PAYMAXIS_POLL_ENABLED="1"
```

On Vercel the cron drives the poll; there is no in-process timer.

What was established, so none of it has to be rediscovered:

| | |
|---|---|
| Host | `https://app.paymaxis.com` — **not** `api.paymaxis.com`, which does not exist |
| Path | `GET /api/v1/payments` — the singular `/payment` 404s |
| Auth | `Authorization: Bearer <key>` — `X-Api-Key` returns 401 |
| Records | under `result` (singular) |
| Order | newest first |
| Page size | `limit`, up to 200 |
| Paging | `offset` only — `page`, `skip`, `after`, `startId` are accepted and ignored |
| More pages | `hasMore` boolean |
| Date filter | **none exists** — nine candidate names were all silently ignored |

Because there is no date filter, the poller reads from the newest end and stops
as soon as a page is entirely known. Steady state is one request per poll per
shop; a cold start pages through the history once.

`scripts/discover-paymaxis.mjs` re-runs the whole probe if the API ever changes.

## Getting events flowing

Unchanged by the move to Vercel — see `DEPLOY-LIVE-DATA.md` §3. In short: either
the CRM forwards a copy of each callback (needs nothing from Paymaxis), or
Paymaxis adds a second webhook destination alongside the existing one.

Point either at `https://api.dashboard.tradin.com/api/webhooks/paymaxis`.

When forwarding from the CRM, forward the **raw body bytes**, not a
parsed-and-re-serialised object: the signature is an HMAC over exactly those
bytes, and re-serialising reorders keys and changes whitespace.

---

## Plan limits worth knowing before you pick one

**Cron granularity is the one that matters.** On Hobby, cron jobs run **once per
day** and you get two. On Pro you can schedule any interval.

For now this is survivable, because polling is not the main path — Paymaxis has
no read API you can reach yet, so the cron is a placeholder and webhooks carry
everything. Webhooks are unaffected by plan: they arrive whenever they arrive.
If you later get a working read API and want minute-level polling, that is the
reason to go Pro.

`maxDuration` is set to 60s, the Hobby ceiling.

---

## Confirm it is live

| Check | Expected |
|---|---|
| `GET /api/health` | `{"status":"ok","database":"up"}` |
| `GET /api/dashboard/feed` | `"live": true` once real events exist |
| `GET /api/paymaxis/status` | `"schedule": "cron"` |
| `GET /api/webhooks/events` | your real transactions |
| Dashboard live feed | real payment IDs, not `TX-8xxxx` |

`"live": false, "simulated": true` means nothing has been ingested yet and you
are seeing the placeholder feed. `"simulated": false` with an empty list means
`LIVE_SIMULATE=false` is set and the dashboard is honestly showing that no
payments have arrived.

---

## If you later want to move off Vercel

Nothing here is one-way. `apps/api/Dockerfile` still builds and runs the same
app, `src/main.ts` still serves it as a long-running process, and the SSE
endpoint is still wired up. Point `NEXT_PUBLIC_LIVE_TRANSPORT=sse` at it and the
dashboard switches back to push.
