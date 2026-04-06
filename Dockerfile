# OpenPawl — multi-stage Docker build
# Build:  docker compose build
# Run:    docker compose up -d

FROM oven/bun:1-alpine AS builder

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

# ── Production ─────────────────────────────────────
FROM node:20-alpine AS production

WORKDIR /app

COPY package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Data directories (mounted as volume in production)
RUN mkdir -p /home/node/.openpawl/memory /home/node/.openpawl/sessions \
    /home/node/.openpawl/cache /home/node/.openpawl/templates \
    && chown -R node:node /home/node/.openpawl /app

RUN chmod +x /app/dist/cli.js

USER node

ENV NODE_ENV=production
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD wget -q -O- http://localhost:8000/ || exit 1

CMD ["node", "/app/dist/cli.js", "web", "-p", "8000"]
