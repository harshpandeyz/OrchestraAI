# Production image for OrchestraAI (adaptive agent runtime).
# Backend is zero-dependency Node 20+; frontend is a static Vite build.
# The runtime serves the built console itself on :8787 (UI + API, one port).
# Build:  docker build -t orchestraai .
# Run:    docker run -p 8787:8787 \
#           -e RUNTIME_MODE=live -e OPENROUTER_API_KEY=$OPENROUTER_API_KEY \
#           -e FRONTEND_ORIGIN=https://your-frontend.example \
#           orchestraai
# Without provider credentials the server runs in explicit DEMO mode, but
# production still requires API auth and DATA_ENCRYPTION_KEY.
# FRONTEND_ORIGIN is required in production: the API reflects only configured
# origins (no wildcard CORS). DATA_ENCRYPTION_KEY must be injected at runtime.

FROM node:20-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
ENV RUNTIME_DATA_DIR=/var/lib/orchestraai
WORKDIR /app
COPY package.json ./
COPY backend/server.js backend/data.js ./backend/
COPY backend/src ./backend/src
COPY backend/test/runtime.test.js backend/test/fixture-pass.js ./backend/test/
COPY --from=frontend-build /app/frontend/dist ./frontend/dist
RUN mkdir -p /var/lib/orchestraai && chown -R node:node /var/lib/orchestraai
VOLUME ["/var/lib/orchestraai"]
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:8787/api/ready').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "backend/server.js"]
