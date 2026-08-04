# Production image for the OpsOS API.
#
# Multi-stage so the runtime image carries no dev dependencies or TypeScript
# sources. The Prisma client is generated during the build, because it is
# gitignored and must exist before the app can start.

FROM node:22-alpine AS build
WORKDIR /app

# Dependency manifests first, so a source-only change reuses the install layer.
COPY package.json package-lock.json* ./
RUN npm ci

COPY prisma ./prisma
COPY prisma.config.ts ./
# DATABASE_URL is read by prisma.config.ts at generate time. Generation needs no
# reachable database — the value only has to parse.
ENV DATABASE_URL="postgresql://user:pass@localhost:5432/db"
RUN npx prisma generate

COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies from the module tree we are about to copy.
RUN npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Run unprivileged: a webhook receiver is internet-facing.
RUN addgroup -S app && adduser -S app -G app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/generated ./generated
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./

USER app
EXPOSE 4000

# The container is unhealthy if the app cannot answer, so an orchestrator
# restarts it rather than leaving a dead listener accepting webhooks.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/main"]
