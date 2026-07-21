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

### Vercel (recommended)

This is a monorepo, so Vercel needs to know the app lives in `apps/web`. That is
the **one** setting to get right — then Vercel builds the Next.js app natively.

1. In Vercel → **Add New Project** → import this repo.
2. **Root Directory** → **`apps/web`** (Edit → select the folder). This is the
   critical step; without it Vercel builds the empty repo root and serves a 404.
3. Leave **Framework Preset = Next.js** and **Build/Output/Install on their
   defaults** (do not override them — no `vercel.json` is needed).
4. **Environment variables:** leave `NEXT_PUBLIC_API_URL` unset for a demo
   preview, or set it to `https://<your-api>/api` for live data.
5. **Deploy** → `https://<project>.vercel.app`.

> Already imported and seeing a 404? Go to **Settings → Build & Deployment**,
> set **Root Directory** to `apps/web`, clear any custom Build Command / Output
> Directory (back to defaults), then **Deployments → Redeploy**.

The dashboard shows a "Demo data" badge until `NEXT_PUBLIC_API_URL` points at a
reachable API.

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
