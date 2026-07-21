# Deploying OpsOS

There are two independently deployable pieces: the **web** frontend
(`apps/web`) and the **api** backend (`apps/api`). The frontend can run on its
own in **demo mode** — useful for a quick live preview URL — and switches to
live data automatically once you point it at a running API.

---

## Fastest path to a live URL (frontend only, demo mode)

The frontend renders the full dashboard with bundled demo data when no API is
configured. It's built as a **fully static site**, so it deploys to any static
host with zero configuration.

### Vercel — zero config (recommended)

A root [`vercel.json`](./vercel.json) is committed, so Vercel needs **no
settings at all**:

1. In Vercel → **Add New Project** → import this repo.
2. **Deploy.** (Don't set a Root Directory, don't change build settings — the
   committed `vercel.json` builds `apps/web` as a static export to `apps/web/out`.)
3. You get a `https://<project>.vercel.app` URL showing the dashboard.

To go live with real data later, add an env var `NEXT_PUBLIC_API_URL` =
`https://<your-api>/api` and redeploy. Until then a "Demo data" badge shows.

> Why static export? The frontend is a client-side SPA that talks to the API
> over HTTP — no server-side rendering is needed — so a static build is simpler
> and hosts anywhere. `vercel.json` runs `STATIC_EXPORT=1 npm run build:web`.

### Any other static host (Netlify, Cloudflare Pages, S3, GitHub Pages)

```bash
npm install
npm run build:static      # outputs apps/web/out/
# then serve/upload the apps/web/out directory
```

### Node host (SSR-style, if you prefer)

```bash
cd apps/web
npm install
npm run build      # normal Next build (no STATIC_EXPORT)
npm run start      # serves on $PORT (default 3000)
```

---

## Full stack (live data + login)

The API needs PostgreSQL. Locally that's Docker; in the cloud use any managed
Postgres (Neon, Supabase, RDS, Prisma Postgres, …).

### 1. Database

```bash
# local
npm run infra:up           # Postgres + Redis via Docker
# then, from apps/api, set DATABASE_URL and run:
npm run db:migrate
npm run db:seed            # creates the seeded admin login
```

For a hosted DB, set `DATABASE_URL` to its connection string and run the same
migrate + seed.

### 2. API (`apps/api`)

Deploy to any Node host (Render, Railway, Fly, a container platform, …):

```bash
cd apps/api
npm install
npm run build
node dist/main         # listens on $PORT (default 4000), API under /api
```

Required env: `DATABASE_URL`, `JWT_SECRET`, `WEB_ORIGIN` (your frontend origin,
for CORS). Swagger docs are served at `/api/docs`.

### 3. Point the frontend at it

Set `NEXT_PUBLIC_API_URL=https://<your-api-host>/api` on the web deployment and
redeploy. The login screen (`/login`) now authenticates against the API, and the
dashboard streams live figures from `GET /api/dashboard/summary`.

Seeded dev login: `mohammad@tradin.com` / `OpsOS!2026` (change before real use).
