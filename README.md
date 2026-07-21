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
npm run db:migrate     # applies prisma/migrations
npm run db:seed        # seeds an admin user + payment gateways
```

The seed creates an admin login:

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
| `npm run db:migrate`| Run Prisma migrations                        |
| `npm run db:seed`   | Seed baseline data                           |

---

## Current status

**Phase 1 (foundation) — in progress.** The app shell, design system, and a
fully-designed Dashboard homepage (with representative mock data) are built.
The backend has auth (JWT + RBAC scaffolding), a health endpoint, the full
Prisma data model for core entities, and Swagger docs. Remaining modules are
scaffolded as "coming soon" pages and tracked in the roadmap.

See [`ROADMAP.md`](./ROADMAP.md) for the detailed build plan.
