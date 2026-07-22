# Operations OS (OpsOS)

> A real-time operational command center for online brokerage operations.

OpsOS is the single source of truth for Operations, Compliance, Support, and
Executive teams at a Forex/CFD brokerage. It replaces the sprawl of Excel,
Google Sheets, and half a dozen dashboards with one action-driven platform.
Every screen answers one question: **"What should Operations do next?"**

This repository is a monorepo containing the web frontend and the API backend.
It is being built in phases — see [`ROADMAP.md`](./ROADMAP.md) for what's done
and what's next.

---

## Architecture

```
Ops-Dashboard/
├── apps/
│   ├── web/          Next.js 16 (App Router) + TypeScript + Tailwind v4 frontend
│   └── api/          NestJS + Prisma (PostgreSQL) API-first backend
├── docker-compose.yml   Local Postgres 16 + Redis 7
└── package.json      npm workspaces root
```

| Layer     | Technology                                                       |
| --------- | ---------------------------------------------------------------- |
| Frontend  | Next.js 16, TypeScript, TailwindCSS v4, shadcn-style UI, Recharts |
| Backend   | NestJS, Prisma ORM v7 (pg driver adapter), JWT auth, Swagger      |
| Database  | PostgreSQL 16                                                    |
| Cache/Queue | Redis 7                                                        |
| Infra     | Docker Compose (local), GitHub Actions (CI, planned)             |

### Design language

Dark-first, premium SaaS aesthetic inspired by Linear, Stripe, and Vercel.
Semantic-only color palette (never saturated):

- Background `#0B1220`, Cards `#131A2A`
- Accents: blue, green, red, orange, purple — used semantically only
- Glassmorphism surfaces, large spacing, rounded cards, soft shadows

---

## Getting started

### Prerequisites

- Node.js 20.19+ (22 recommended)
- Docker + Docker Compose (for Postgres/Redis)

### 1. Install dependencies

```bash
npm install
```

### 2. Start infrastructure (Postgres + Redis)

```bash
npm run infra:up
```

### 3. Configure environment

```bash
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
```

### 4. Set up the database

```bash
npm run db:generate    # generate the Prisma client
npm run db:push        # sync the schema to the database (or db:migrate)
npm run db:seed        # seed users, clients, gateways, transactions,
                       # KYC cases, tickets, incidents and audit logs
```

The seed populates a full operational dataset (10 users, 10 clients, 7 PSPs,
42 transactions, KYC cases, tickets, incidents, audit logs) and an admin login:

- **Email:** `mohammad@tradin.com`
- **Password:** `OpsOS!2026`

> Change these before any non-local deployment.

### 5. Run the apps

```bash
# Terminal 1 — API on :4000  (Swagger at /api/docs)
npm run dev:api

# Terminal 2 — Web on :3000
npm run dev:web
```

Open [http://localhost:3000](http://localhost:3000).

---

## Available scripts (root)

| Script              | Description                                  |
| ------------------- | -------------------------------------------- |
| `npm run dev:web`   | Start the Next.js frontend (port 3000)       |
| `npm run dev:api`   | Start the NestJS API in watch mode (port 4000) |
| `npm run build`     | Build both apps                              |
| `npm run lint`      | Lint both apps                               |
| `npm run infra:up`  | Start Postgres + Redis via Docker Compose    |
| `npm run infra:down`| Stop the infra containers                    |
| `npm run db:push`   | Sync the Prisma schema to the database       |
| `npm run db:migrate`| Run Prisma migrations                        |
| `npm run db:seed`   | Seed the full operational dataset            |

---

## Demo mode & live data

The frontend reads the dashboard from `GET /api/dashboard/summary` via React
Query. When `NEXT_PUBLIC_API_URL` is **unset**, it runs in **demo mode**: no
requests are made and the UI renders bundled demo data (shown by a "Demo data"
badge). Point `NEXT_PUBLIC_API_URL` at a running API and it switches to live
data and requires login at `/login`. This means you can deploy the frontend
alone for a shareable preview URL — see [`DEPLOY.md`](./DEPLOY.md).

## Current status

**Phase 1 (foundation) — largely complete.** The app shell, design system,
motion, ⌘K command palette, and a fully-designed Dashboard are built. The
dashboard is wired to a live API endpoint with automatic demo-mode fallback,
and there's a working login flow (JWT + auth guard). The backend has auth,
health, the dashboard summary endpoint, the full Prisma data model, and Swagger
docs. Other modules are scaffolded as "coming soon" pages.

See [`ROADMAP.md`](./ROADMAP.md) for the detailed build plan and
[`DEPLOY.md`](./DEPLOY.md) for deployment.
