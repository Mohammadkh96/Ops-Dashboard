# Going live with Paymaxis data

Everything on the OpsOS side is built and tested. What remains is a delivery
route: Paymaxis has to be able to reach this API, and the web app has to be
pointed at it.

**Nothing here changes your existing Paymaxis → CRM integration.** The CRM's
webhook URL stays exactly as it is.

---

## 1. Prove it first, without deploying anything

Ten minutes, zero risk. Run the API locally, expose it with a tunnel, and send
one real callback at it.

```bash
cd apps/api
npm ci
npx prisma migrate deploy          # creates the tables
PAYMAXIS_SIGNING_KEYS="5141=<mauritius signing key>,6321=<saint lucia signing key>" \
  npm run start:dev
```

In a second terminal:

```bash
npx ngrok http 4000                # gives you https://<something>.ngrok.app
```

Have one callback POSTed to `https://<something>.ngrok.app/api/webhooks/paymaxis`,
then check what arrived:

```bash
curl -s http://localhost:4000/api/webhooks/events | head -c 2000
```

**You do not need to know which header carries the signature.** The receiver
computes the expected HMAC and looks for any header matching it, then logs:

```
Signature verified from header "x-signature" (hex).
Pin it with PAYMAXIS_SIGNATURE_HEADER=x-signature
```

Set that variable afterwards so the check is pinned rather than searched.

If the signature does not verify, set `PAYMAXIS_WEBHOOK_CAPTURE=1` temporarily.
That stores the callback unverified and logs every header it saw, so the payload
and header can be inspected. **Turn it off before going live** — while it is on,
anyone who finds the URL can inject events.

---

## 2. Deploy the API

```bash
docker build -t opsos-api -f apps/api/Dockerfile apps/api
docker run -d --name opsos-api -p 4000:4000 --env-file apps/api/.env.production opsos-api
```

Put it behind HTTPS (your load balancer, Caddy, nginx, or a platform that
terminates TLS). Paymaxis will not post to plain HTTP.

`apps/api/.env.production`:

```ini
DATABASE_URL="postgresql://user:pass@host:5432/opsos"
WEB_ORIGIN="https://<your dashboard host>"
PORT=4000

# One signing key per shop — each shop signs with its own.
PAYMAXIS_SIGNING_KEYS="5141=<mauritius key>,6321=<saint lucia key>"
# Pin this once the log above tells you the real header name.
PAYMAXIS_SIGNATURE_HEADER="x-signature"

# Never 1 in production.
PAYMAXIS_WEBHOOK_CAPTURE="0"
# The demo simulator stands down on the first real event anyway; this is belt
# and braces so a live dashboard can never show invented rows.
LIVE_SIMULATE="false"
```

Run migrations against the production database once: `npx prisma migrate deploy`.

---

## 3. Get the events flowing

Two routes. **A needs nothing from Paymaxis and is the safer one.**

### A. The CRM forwards a copy

Your CRM already receives every callback. Add a fire-and-forget POST at the
**end** of the handler, after it has finished its own work:

```coldfusion
<!--- AFTER the CRM's own processing is complete --->
<cftry>
  <cfhttp url="https://<opsos-host>/api/webhooks/paymaxis" method="post"
          timeout="2" throwonerror="false">
    <cfhttpparam type="header" name="Content-Type" value="application/json">
    <!--- forward the signature header exactly as received --->
    <cfhttpparam type="header" name="X-Signature" value="#incomingSignatureHeader#">
    <!--- RAW body bytes, not a re-serialised struct --->
    <cfhttpparam type="body" value="#rawRequestBody#">
  </cfhttp>
  <cfcatch><!--- swallowed: OpsOS must never affect the CRM ---></cfcatch>
</cftry>
```

Two things matter here:

- **Forward the raw body**, not a parsed-and-re-serialised object. The signature
  is an HMAC over the exact bytes; re-serialising reorders keys and changes
  whitespace, and verification then fails.
- **2-second timeout, errors swallowed.** If OpsOS is slow or down, the CRM
  carries on exactly as it does today.

### B. A second webhook destination in Paymaxis

Ask Paymaxis to add `https://<opsos-host>/api/webhooks/paymaxis` **alongside**
the existing URL. No CRM change at all. Only viable if they support more than one
destination per shop — worth asking, because it is the cleanest option.

### C. Polling (only if there is a read API)

If Paymaxis confirms a REST endpoint for listing payments:

```ini
PAYMAXIS_SHOPS="5141=<api key>,6321=<api key>"   # note: shopId:apiKey
PAYMAXIS_POLL_ENABLED="1"
PAYMAXIS_BASE_URL="https://<their api host>"
PAYMAXIS_PAYMENTS_PATH="/api/v1/payment"
```

Then `POST /api/paymaxis/sync` to run one read and see `{fetched, stored,
broadcast}`. The client can only issue GET requests, so it cannot modify
anything at Paymaxis even though the keys carry write permission.

---

## 4. Point the dashboard at the API (Vercel)

Two arrangements work:

- **Everything on Vercel** — two Vercel projects from this repo, the API as a
  serverless function with polling instead of SSE and cron instead of a
  background timer. See **`DEPLOY-VERCEL.md`**, which is the complete guide.
- **UI on Vercel, API on an always-on host** (Railway, Render, Fly, your own
  server). Keeps the SSE push feed and a normal in-process poller. The steps
  below cover this one.

In Vercel → Project → Settings → Environment Variables:

```
NEXT_PUBLIC_API_URL = https://<your api host>/api
```

Then redeploy — the value is baked in at build time, so an existing deployment
will not pick it up until it rebuilds.

On the API, allow the Vercel origins. Preview deployments each get their own
URL, so list the production domain and (if you want previews to work) the
wildcard:

```ini
WEB_ORIGIN="https://<your app>.vercel.app,*.vercel.app"
```

Two things that will otherwise waste an afternoon:

- **The API must be HTTPS.** Vercel serves over HTTPS and a browser blocks
  plain-HTTP requests from an HTTPS page as mixed content, with no useful error.
- **Exact origins are safer than the wildcard.** With credentials enabled,
  `*.vercel.app` lets any site on that domain make credentialed requests. Use it
  for previews, and pin the production domain.

## 4b. Point the dashboard at the API (any host)

**This step is easy to forget and nothing appears without it.** With
`NEXT_PUBLIC_API_URL` unset the web app runs in demo mode: it simulates events in
the browser and never connects.

```bash
NEXT_PUBLIC_API_URL="https://<opsos-host>/api" npm --workspace apps/web run build
```

---

## 5. Confirm it is live

| Check | Expected |
|---|---|
| `GET /api/health` | `200` |
| `GET /api/webhooks/events` | your real transactions |
| `GET /api/dashboard/summary` | `"live": true`, `"window": "24h"` |
| Dashboard live feed | real payment IDs, not `TX-8xxxx` |

`"live": false` means no events have been ingested — the KPI tiles are still
showing representative defaults.

---

## Data protection

Payloads carry date of birth, IP, cardholder name, card expiry and 3-D Secure
material. All of it is stripped before storage; the customer reference, email and
the already-masked card number are kept because operations need them. Override
with `PAYMAXIS_REDACT_KEYS`, or `PAYMAXIS_STORE_RAW=full` to keep everything —
only sensible while debugging.

## Rotate the credentials

The signing keys and API keys shared during development should be rotated once
this is running. **Check first whether the CRM uses the same API keys** — if it
does, rotating them breaks the CRM. Ask Paymaxis for a separate key per shop for
the dashboard so it can be rotated independently.
