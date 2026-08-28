# syntax=docker/dockerfile:1

ARG NODE_VERSION=22-alpine

# ---- deps: install full (incl. dev) deps once, with native build tools ----
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
# better-sqlite3 is a native addon; these are only needed if no prebuilt
# binary matches this platform, and don't ship in the final image.
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci

# ---- build: compile TypeScript against the full dep set ----
FROM node:${NODE_VERSION} AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- prod-deps: same install, pruned to production deps only ----
FROM deps AS prod-deps
RUN npm prune --omit=dev

# ---- runtime: slim, non-root, no build tools or source ----
FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production
WORKDIR /app

RUN addgroup -S app && adduser -S app -G app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Persisted SQLite lives here; mount a volume at this path to keep data
# across container restarts/redeploys.
RUN mkdir -p /app/data && chown -R app:app /app/data
ENV DB_PATH=/app/data/data.sqlite

USER app
EXPOSE 3000

CMD ["node", "dist/server.js"]
