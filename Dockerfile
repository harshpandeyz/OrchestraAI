# Production image for OrchestraAI (adaptive agent runtime).
# Multi-stage build: frontend build -> minimal Node runtime.
# The runtime serves the built console itself on :8787 (UI + API, one port).
# Production: docker build -t orchestraai .
# Run via compose (recommended — wires Postgres, Redis, sandbox worker):
#   POSTGRES_PASSWORD=... SANDBOX_WORKER_TOKEN=... ISOLATED_EXECUTOR_TOKEN=... \
#   DATA_ENCRYPTION_KEY=... FRONTEND_ORIGIN=https://console.example \
#   docker compose -f deploy/docker-compose.yml up --build -d
# Without provider credentials the server runs in explicit DEMO mode, but
# production still requires API auth and DATA_ENCRYPTION_KEY.
# FRONTEND_ORIGIN is required in production: the API reflects only configured
# origins (no wildcard CORS). DATA_ENCRYPTION_KEY must be injected at runtime.

FROM node:22-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
ENV RUNTIME_DATA_DIR=/var/lib/orchestraai
WORKDIR /app

# Create non-root user before copying anything
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Reproducible root install: package.json + lockfile, npm ci (pg for Postgres
# migrations/datastore, ioredis for Redis coordination when configured).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy backend source (excluding node_modules from host, nothing from backend/node_modules)
COPY backend/server.js backend/data.js ./backend/
COPY backend/src ./backend/src
COPY backend/migrations ./backend/migrations
COPY backend/test/runtime.test.js backend/test/fixture-pass.js ./backend/test/
# Do NOT copy backend/.runtime-data or runtime data directories into image

# Deployment scripts: file-layout migration + container entrypoint (runs file
# migration, then Postgres schema migrations when postgres is authoritative,
# then execs the server — any migration failure refuses to boot).
COPY deploy/scripts/migrate.js deploy/scripts/docker-entrypoint.js ./deploy/scripts/

# Copy built frontend dist from build stage
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

# Create runtime data directory and set ownership (migration happens at startup)
RUN mkdir -p /var/lib/orchestraai && chown -R appuser:appgroup /var/lib/orchestraai

# Set correct permissions for the app directory
RUN chown -R appuser:appgroup /app

# Switch to non-root user
USER appuser

# Healthcheck: liveness - process always alive (/api/health never fails on dependency outage)
# Exit code 0 = process responding; 1 = not responding
HEALTHCHECK --interval=40s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

EXPOSE 8787

CMD ["node", "deploy/scripts/docker-entrypoint.js"]
