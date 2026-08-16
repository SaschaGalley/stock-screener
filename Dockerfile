# One image, one port: the Express API also serves the built SPA (see the
# static handler at the end of src/server.ts). The nightly pipeline runs
# in-process, which is why this must be a long-lived service and not a
# scale-to-zero function. State lives in Postgres (a separate service, see
# docker-compose.yml) plus the small /data volume for downloaded filings.

# ── Build ────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

# corepack installs the exact pnpm pinned in package.json's "packageManager",
# so this image and a developer's machine resolve the same tree.
RUN corepack enable

# Manifests and the lockfile first: this layer only busts when a dependency
# changes, not when a source file does. One workspace covers both packages, so
# a single install populates the server and the SPA.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json ./web/
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
COPY web ./web

# Server → dist/, SPA → web/dist/. The SPA imports src/models.ts across the
# package boundary, so both must be built from the same tree.
RUN pnpm run build && pnpm run web:build

# Production dependencies as a real directory tree. pnpm's normal layout is a
# symlink farm pointing into a content-addressed store, which does not survive
# a COPY into another stage; `pnpm deploy` resolves it into something that does.
#
# --legacy because the server depends on no workspace package (web/ is built
# into static files, not imported at runtime), so there is nothing to inject and
# pnpm 10+ otherwise refuses to deploy.
RUN pnpm deploy --filter=investment-cli --prod --legacy /deploy

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# tzdata so a cron schedule in Europe/Berlin means Europe/Berlin, including
# across the DST switch.
RUN apk add --no-cache tzdata

COPY --from=build /deploy/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
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
