# MoltBridge — Multi-stage production build
# Usage: docker build -t moltbridge .
# Run:   docker run -p 3040:3040 --env-file .env moltbridge

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

# ---- Dependencies ----
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod=false

# ---- Build ----
FROM deps AS build
COPY tsconfig.json ./
COPY src/ src/
RUN pnpm build

# ---- Production deps only ----
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# ---- Runtime ----
FROM node:22-alpine AS runtime
WORKDIR /app

# Non-root user for security
RUN addgroup -g 1001 moltbridge && adduser -u 1001 -G moltbridge -s /bin/sh -D moltbridge

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
COPY public/ public/

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3040/health || exit 1

USER moltbridge
EXPOSE 3040

ENV NODE_ENV=production
ENV PORT=3040

CMD ["node", "dist/index.js"]
