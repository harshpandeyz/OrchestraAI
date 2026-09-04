# Production image for OrchestraAI (adaptive agent runtime).
# Backend is zero-dependency Node 20+; frontend is a static Vite build.
# The runtime serves the built console itself on :8787 (UI + API, one port).
# Build:  docker build -t orchestraai .
# Run:    docker run -p 8787:8787 \
#           -e RUNTIME_MODE=live -e OPENROUTER_API_KEY=$OPENROUTER_API_KEY \
#           -e FRONTEND_ORIGIN=https://your-frontend.example \
#           orchestraai
# Without provider credentials the server runs in explicit DEMO mode.
# FRONTEND_ORIGIN is required in production: the API reflects only configured
# origins (no wildcard CORS) and falls back to http://localhost:5173.

FROM node:20-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
COPY backend/server.js backend/data.js ./backend/
COPY backend/src ./backend/src
COPY backend/test/runtime.test.js backend/test/fixture-pass.js ./backend/test/
COPY --from=frontend-build /app/frontend/dist ./frontend/dist
EXPOSE 8787
CMD ["node", "backend/server.js"]
