# OpsOS Roadmap

This is a large platform being built incrementally from scratch. Each phase
delivers something runnable. Status is kept honest — this file is the source of
truth for what actually exists versus what is planned.

Legend: ✅ done · 🚧 in progress · ⬜ planned

---

## Phase 1 — Foundation & Dashboard 🚧

The skeleton everything else hangs off, plus the homepage that answers
"How healthy is Operations?".

- ✅ npm workspaces monorepo (`apps/web`, `apps/api`)
- ✅ Next.js 16 frontend scaffold (TypeScript, Tailwind v4, App Router)
- ✅ Dark glassmorphism design system + semantic color palette
- ✅ shadcn-style UI primitives (button, card, badge, avatar, dropdown, tooltip, progress, separator)
- ✅ App shell: persistent sidebar + top bar (global search, shift status, notifications, user menu, theme toggle)
- ✅ Dashboard homepage with representative mock data:
  - Operational Health Score, Today's Volume / Deposits / Withdrawals / Revenue
  - Critical Alerts, Pending Work grid, Performance (success/approval/decline/refund)
  - Deposits vs Withdrawals chart, Live Queue, System Status, Team Online
- ✅ "Coming soon" placeholder pages for every nav route (no dead links)
- ✅ NestJS backend scaffold (API-first, Swagger at `/api/docs`)
- ✅ Prisma v7 schema for core entities (User, Shift, Client, KycCase, PaymentGateway, Transaction, Ticket, Incident, AuditLog)
- ✅ JWT auth + RBAC scaffolding (login, `/auth/me`, roles guard/decorator)
- ✅ Health endpoint with DB connectivity check
- ✅ Docker Compose (Postgres 16 + Redis 7) + initial SQL migration
- ✅ Seed script (admin user + 7 payment gateways)
- ✅ Design-system pass: motion (Framer Motion), animated count-up KPIs, inline
  sparklines, live pulse indicators, refined glass/typography/gradients
- ✅ ⌘K command palette (cmdk) — quick actions + jump-to navigation
- ✅ Data-viz correctness: validated CVD-safe categorical chart pair
  (blue / magenta), legend + crosshair tooltip
- ✅ React Query + API client layer on the frontend (`lib/api`, `hooks/use-dashboard`)
- ✅ `GET /api/dashboard/summary` endpoint (derives from DB, safe defaults)
- ✅ Dashboard reads live data with automatic demo-mode fallback when no API is
  configured or the API is unreachable (shows a status badge)
- ✅ Frontend auth flow: `/login` page, JWT token storage, auth context + route
  guard (pass-through in demo mode)
- ✅ Deployable standalone for a live preview URL — see `DEPLOY.md`
- ⬜ Real-time transport (SSE or WebSocket gateway) for push updates
- ⬜ Persist real transactions/clients so the summary reflects live figures

## Phase 2 — Payments & Transactions 🚧

- ✅ Transactions module: filterable table (search, status, method, PSP) with
  row → detail drawer (amount, fields, risk, timeline)
- ✅ Payment Gateway monitoring grid (success rate, latency, volume, webhook
  failures, live status, sparklines) — tabbed with Transactions
- ✅ Deposits & Withdrawals module views (reuse the transactions table, typed)
- ✅ Shared module primitives: PageHeader, StatTileRow, DataTable, FilterBar,
  Drawer, StatusBadge/RiskBadge
- ⬜ Transaction detail as full page (API response, webhook payload, files, notes)
- ⬜ Withdrawal approval workflow (server-side)
- ⬜ Live Alerts engine (gateway offline, decline/refund spikes, large withdrawal…)

## Phase 3 — Compliance, Incidents & Operations 🚧

- ✅ Compliance / KYC module (queue table, risk score, filters, case drawer with
  sanctions/PEP/AML/EDD screening checklist)
- ✅ Incident management (severity stripes, status, impact, owner, timeline drawer)
- ⬜ Shift management (start/resume/end, checklist, carry-forward, handover)
- ⬜ Team dashboard (workload, tickets, investigations, leaderboard)
- ⬜ Ticketing + SLA monitoring

## Phase 4 — Analytics, Reports & Search 🚧

- ✅ Analytics module (payment success, approvals vs declines, gateway & country
  performance) with validated CVD-safe chart colors + time-range selector
- ⬜ Reports (generate/schedule/email PDF & Excel)
- ⬜ Global search across clients, transactions, tickets, cases, KYC, incidents, gateways, users
- ⬜ Notification center (mentions, assignment, escalation, system events)

## Phase 5 — Admin, Security & AI ⬜

- ⬜ Admin: user management, per-module permissions
- ⬜ Audit logs UI (user, action, timestamp, IP, old/new value, reason)
- ⬜ Security: 2FA, session management, API rate limiting, IP restrictions, sensitive-data masking
- ⬜ Settings & integrations config
- ⬜ AI assistant (summarize incident, suggest root cause, generate reports, detect anomalies, executive summary)

## Phase 6 — Integrations & Infra ⬜

- ⬜ CRM API, Zendesk, MT4/MT5, PSP APIs, KYC providers
- ⬜ Slack / Teams / Email / SMS / Telegram / Discord / Webhooks
- ⬜ Redis-backed queue workers (event-driven)
- ⬜ GitHub Actions CI, containerized deploy, Kubernetes manifests

---

## Notes for future sessions

- The Dashboard currently reads from `apps/web/src/lib/mock-dashboard.ts`.
  Replacing this with live API calls is the first task of finishing Phase 1.
- Prisma is on **v7** — it uses the `prisma-client` generator with an explicit
  output path (`apps/api/generated/prisma`) and the `@prisma/adapter-pg` driver
  adapter. See `apps/api/.claude/skills/prisma-upgrade-v7/` for the conventions.
- **`@types/react` is pinned to `19.2.9`** via a root `overrides` block (and in
  `apps/web` devDependencies). `@types/react@19.2.17` has a regression that
  breaks Radix UI's `ComponentPropsWithoutRef<typeof Primitive.span>` typing
  (every Radix component loses `className`/`children`). Keep a single, pinned
  copy across the workspace — do not let a second `@types/react` version get
  installed, or you'll hit "two different types with this name" ref errors.
- Docker image pulls may be blocked in restricted network sandboxes; the
  `docker-compose.yml` and the committed initial migration are valid and run in
  a normal environment.
