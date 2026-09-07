# syntax=docker/dockerfile:1.20

# neohomepage
#
# Built last, and on purpose. If containerising had required a single `if (process.env.DOCKER)`,
# the local-first constraint would have been broken somewhere earlier and this file is where that
# debt would have surfaced. `git diff --stat f12..HEAD -- packages/app/src/` printing nothing is
# the check that says it did not.
#
# The server runs TypeScript directly through Node's type stripping, so there is no server build
# step and no emitted JavaScript to ship — the runtime image carries the sources it actually runs.
# Only the browser bundle is compiled.

# ---------------------------------------------------------------------------------------------
# The base, pinned to a MAJOR and an Alpine release.
#
# Never `node:lts-alpine`: that tag becomes Node 26 the day 26 goes LTS, which is a version bump
# arriving through a rebuild nobody asked for. Never `corepack enable` either — corepack is not
# distributed with Node >= 25, so the line becomes a time bomb pointed at exactly that upgrade.
# ---------------------------------------------------------------------------------------------
ARG NODE_IMAGE=node:24-alpine3.24
ARG PNPM_VERSION=12.3.4

# ---------------------------------------------------------------------------------------------
# base — pnpm and the manifests. Shared, so the two installs below do not each copy them.
# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /src
ENV PNPM_HOME=/pnpm

# Manifests only, so a source-only change reuses every install layer below.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/app/package.json packages/app/
COPY packages/catalog-schema/package.json packages/catalog-schema/

# ---------------------------------------------------------------------------------------------
# deps — every dependency, for building the browser bundle.
#
# `--ignore-scripts`: nothing this image builds needs a lifecycle script. The workspace allows
# exactly one (esbuild, for the Vite 5 inside VitePress, which builds the docs site and not this),
# so skipping them is faster and one fewer way for a dependency to run code at build time.
# ---------------------------------------------------------------------------------------------
FROM base AS deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm install --frozen-lockfile --ignore-scripts

# ---------------------------------------------------------------------------------------------
# build — the browser bundle.
# ---------------------------------------------------------------------------------------------
FROM deps AS build
COPY . .
RUN pnpm --filter @neohomepage/app build

# ---------------------------------------------------------------------------------------------
# prod-deps — production dependencies, installed into an EMPTY tree.
#
# `FROM base`, emphatically not `FROM deps`. Running `pnpm install --prod` over a completed full
# install does not prune `node_modules/.pnpm`; it only rewrites the top-level links. The first
# version of this file did exactly that and shipped TypeScript, Playwright, Prettier, esbuild and
# Shiki inside the production image — 310 packages where there should be 30, and 115 MB
# compressed against a 90 MB ceiling. Nothing but building the image would have found it.
#
# Also deliberately not `pnpm deploy`, which flattens the workspace into one directory. Flattening
# COPIES @neohomepage/catalog-schema into node_modules, and Node refuses to strip types from a
# file whose real path is inside node_modules — a container built that way starts and immediately
# dies with ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING. In the workspace layout the package is a
# symlink, Node resolves the real path outside node_modules, and stripping is allowed. Which is to
# say: the image runs the sources the same way a developer does, and that is what "no code change
# was needed to containerise" is supposed to mean.
# ---------------------------------------------------------------------------------------------
FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm install --frozen-lockfile --prod --ignore-scripts

# ---------------------------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

# su-exec is 20 KB and is the whole reason this image can both fix a bind mount's ownership and
# still run the server unprivileged.
RUN apk add --no-cache su-exec

LABEL org.opencontainers.image.title="neohomepage" \
      org.opencontainers.image.description="A self-hosted homepage dashboard you edit in the browser, not in YAML" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/oauramos/neohomepage"

# The memory cap is the whole reason this project rejected Next.js, so it is set in the image
# rather than left to a compose file someone will copy without it. 192 MB of old space against a
# measured steady state around 90 MB leaves room for a publish render and still fits a 1 GB box
# alongside everything else it is running.
#
# TMPDIR is set explicitly so it is a decision rather than an inheritance. The hazard is real:
# Debian 13 sizes the /tmp tmpfs from the HOST's RAM inside an LXC and charges every byte written
# there to the container's cgroup, so temp files can OOM a container nowhere near its own limit.
# This app does not walk into it — the atomic writer puts its temp file next to its target, inside
# the data volume, and nothing in the server calls os.tmpdir(). Pointing TMPDIR under /data would
# be worse than useless: the volume mounts over it, so the directory would not exist for whichever
# dependency eventually does reach for it. So: /tmp, capped by a small tmpfs in compose.yaml.
ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=192" \
    NEOHOMEPAGE_DATA_DIR=/data \
    NEOHOMEPAGE_CATALOG_DIR=/app/catalog \
    NEOHOMEPAGE_HOST=:: \
    NEOHOMEPAGE_PORT=7575 \
    TMPDIR=/tmp

WORKDIR /app

# The workspace, minus everything that only builds it.
#
# `--chown` on each COPY rather than a `chown -R` afterwards: a recursive chown rewrites every
# inode, and Docker stores that as a second full copy of node_modules in a new layer — roughly
# doubling the image for what is only a metadata change.
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

# A NAMED volume inherits the ownership of this directory, so setting it here is what makes that
# case work with no entrypoint logic at all. A BIND mount carries the host's ownership instead,
# which no build-time chown can reach — the entrypoint handles that one, and explains itself.
RUN mkdir -p /data && chown node:node /data && chmod 0755 /usr/local/bin/docker-entrypoint.sh

# Deliberately NOT `USER node`. The entrypoint starts as root only long enough to make a
# bind-mounted /data writable, then `exec`s to an unprivileged user — so the server still runs as
# uid 1000 and is still PID 1. Running the image with `--user` skips that entirely.
VOLUME ["/data"]
EXPOSE 7575

# Asks for the board, not for a bespoke health endpoint: the thing being checked is that a browser
# would get a page, and a /healthz that returns 200 while the board 500s is a green light on a
# broken dashboard.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.NEOHOMEPAGE_PORT||7575)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The entrypoint `exec`s, so the shell replaces itself and the server is PID 1 receiving SIGTERM
# directly — a container that misses it gets SIGKILLed mid-write.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "packages/app/src/server/main.ts"]
