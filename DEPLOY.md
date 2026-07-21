# Deploying OpsOS

There are two independently deployable pieces: the **web** frontend
(`apps/web`) and the **api** backend (`apps/api`). The frontend can run on its
own in **demo mode** — useful for a quick live preview URL — and switches to
live data automatically once you point it at a running API.

---

## Fastest path to a live URL (frontend only, demo mode)

The frontend renders the full dashboard with bundled demo data when no API is
configured. Deploy just `apps/web` and you get a shareable URL in ~1 minute.

### Vercel (recommended)

1. Push this repo to GitHub (already done on your branch).
2. In Vercel → **Add New Project** → import the repo.
3. Set **Root Directory** to `apps/web`.
4. Framework preset: **Next.js** (auto-detected). Leave build/output defaults.
5. **Environment variables:** leave `NEXT_PUBLIC_API_URL` **unset** for a demo
   preview, or set it to your API URL (e.g. `https://api.example.com/api`) to
   go live with real data.
6. **Deploy.** You'll get a `https://<project>.vercel.app` URL.

> The dashboard shows a "Demo data" badge until `NEXT_PUBLIC_API_URL` points at
> a reachable API.

### Any static/Node host

```bash
cd apps/web
npm install
npm run build      # produces .next
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
