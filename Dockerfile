# syntax=docker/dockerfile:1.20

# The server runs TypeScript directly through Node's type stripping, so the runtime image carries
# the sources; only the browser bundle is compiled.

# Pinned to a major and an Alpine release: `node:lts-alpine` would bump the major on a rebuild.
# No `corepack enable`: corepack is not distributed with Node >= 25.
ARG NODE_IMAGE=node:24-alpine3.24
ARG PNPM_VERSION=12.3.4

# base: pnpm and the manifests, shared by both installs below.
FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /src
ENV PNPM_HOME=/pnpm

# Manifests only, so a source-only change reuses every install layer below.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/app/package.json packages/app/
COPY packages/catalog-schema/package.json packages/catalog-schema/

# deps: every dependency, for building the browser bundle. `--ignore-scripts` is safe: the only
# lifecycle script the workspace allows (esbuild) serves the VitePress docs build, not this.
FROM base AS deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm install --frozen-lockfile --ignore-scripts

# build: the browser bundle.
FROM deps AS build
COPY . .
RUN pnpm --filter @neohomepage/app build

# prod-deps: production dependencies into an empty tree. `FROM base`, not `deps`: `pnpm install
# --prod` over a full install does not prune `node_modules/.pnpm`. Not `pnpm deploy`: copying
# catalog-schema into node_modules dies with ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING.
FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm install --frozen-lockfile --prod --ignore-scripts

# runtime
FROM ${NODE_IMAGE} AS runtime

# su-exec lets the entrypoint fix a bind mount's ownership and still run the server unprivileged.
RUN apk add --no-cache su-exec

LABEL org.opencontainers.image.title="neohomepage" \
      org.opencontainers.image.description="A self-hosted homepage dashboard you edit in the browser, not in YAML" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/oauramos/neohomepage"

# 192 MB of old space against a ~90 MB steady state leaves room for a publish render on a 1 GB box.
# TMPDIR stays /tmp (capped by a tmpfs in compose.yaml): under /data the volume would mount over
# it, and an uncapped /tmp inside an LXC is charged to the container's cgroup.
ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=192" \
    NEOHOMEPAGE_DATA_DIR=/data \
    NEOHOMEPAGE_CATALOG_DIR=/app/catalog \
    NEOHOMEPAGE_HOST=:: \
    NEOHOMEPAGE_PORT=7575 \
    TMPDIR=/tmp

WORKDIR /app

# `--chown` per COPY rather than `chown -R` afterwards: a recursive chown stores a second full
# copy of node_modules in a new layer.
COPY --from=prod-deps --chown=node:node /src/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /src/packages/app/node_modules ./packages/app/node_modules
COPY --from=prod-deps --chown=node:node /src/packages/catalog-schema/node_modules ./packages/catalog-schema/node_modules
COPY --from=build --chown=node:node /src/package.json /src/pnpm-workspace.yaml ./
COPY --from=build --chown=node:node /src/packages/app/package.json ./packages/app/
COPY --from=build --chown=node:node /src/packages/catalog-schema/package.json ./packages/catalog-schema/
COPY --from=build --chown=node:node /src/packages/app/src ./packages/app/src
COPY --from=build --chown=node:node /src/packages/catalog-schema/src ./packages/catalog-schema/src
COPY --from=build --chown=node:node /src/packages/app/dist ./packages/app/dist
COPY --from=build --chown=node:node /src/catalog ./catalog

COPY --chown=root:root docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# A named volume inherits this directory's ownership; a bind mount's is fixed by the entrypoint.
RUN mkdir -p /data && chown node:node /data && chmod 0755 /usr/local/bin/docker-entrypoint.sh

# No `USER node`: the entrypoint starts as root to make a bind-mounted /data writable, then
# `exec`s to an unprivileged user. `--user` skips that.
VOLUME ["/data"]
EXPOSE 7575

# Checks the board itself; a health endpoint could be green while the board 500s.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -q -O /dev/null -T 4 "http://127.0.0.1:${NEOHOMEPAGE_PORT:-7575}/"

# The entrypoint `exec`s, so the server is PID 1 and receives SIGTERM directly.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "packages/app/src/server/main.ts"]
