# One image, one port: the Express API also serves the built SPA (see the
# static handler at the end of src/server.ts). The nightly pipeline runs
# in-process, which is why this must be a long-lived service and not a
# scale-to-zero function. State lives in Postgres (a separate service, see
# docker-compose.yml) plus the small /data volume for downloaded filings.

# ── Build ────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

# npm (not pnpm): package-lock.json is what the repository actually commits, so
# a clean checkout can always reproduce this build.
COPY package.json package-lock.json ./
RUN npm ci

# The web app is its own npm project with its own lockfile.
COPY web/package.json web/package-lock.json ./web/
RUN npm ci --prefix web

COPY tsconfig.json ./
COPY src ./src
COPY web ./web

# Server → dist/, SPA → web/dist/. The SPA imports src/models.ts across the
# package boundary, so both must be built from the same tree.
RUN npm run build && npm run web:build

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# tzdata so a cron schedule in Europe/Berlin means Europe/Berlin, including
# across the DST switch.
RUN apk add --no-cache tzdata

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist

# /data now holds only the two file-shaped things: EDGAR filings and generated
# reports. Everything measurable is in Postgres. Owned by `node` so the
# unprivileged runtime user can write to a fresh named volume (Docker seeds a
# new named volume from the image path, ownership included). A bind mount keeps
# the host's ownership — chown it to 1000:1000.
ENV DATA_DIR=/data \
    PORT=4317 \
    TZ=Europe/Berlin
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 4317

# Liveness only — the probe touches no disk and no upstream API, so a slow
# Yahoo or a long pipeline run can never trigger a restart loop.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4317/api/health >/dev/null 2>&1 || exit 1

CMD ["node", "dist/server.js"]
