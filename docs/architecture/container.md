# The container

The image was built last, and that was the point.

Every phase of this project was validated running locally first — the server, the scheduler, the
publish step, the editor, the MCP tools, the restore drill. If containerising had then required a
single `if (process.env.DOCKER)`, it would have meant the local-first constraint had already been
broken somewhere and nobody had noticed. The check is one command:

```sh
git diff --stat f12..HEAD -- 'packages/*/src/'
```

It prints nothing. No application code changed to put this in a container.

## What is in it

One process. Node 24 on Alpine, the app's sources, its production dependencies, the compiled
browser bundle, and the widget catalog. No database, no Redis, no supervisor, no shell wrapper.

The server runs TypeScript directly through Node's type stripping, so there is no server build
step and nothing compiled to ship for it. Only the browser bundle is built.

## The decisions worth explaining

**The base is pinned to a major and an Alpine release**, `node:24-alpine3.24`. `node:lts-alpine`
would become Node 26 the day 26 goes LTS — a version bump arriving through a rebuild nobody asked
for.

**pnpm is installed with npm**, never `corepack enable`. Corepack is not distributed with Node 25
and later, so that line is a time bomb pointed at exactly the upgrade above.

**The workspace layout is preserved**, rather than flattened with `pnpm deploy`. Flattening copies
`@neohomepage/catalog-schema` into `node_modules`, and Node refuses to strip types from a file
whose real path is inside `node_modules` — a container built that way starts and immediately dies
with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. Keeping the symlink means Node resolves the
real path outside `node_modules` and everything works exactly as it does in development. Which is
the whole idea: the image runs the sources the same way a developer does.

**V8's old space is capped at 192 MB in the image**, not in the compose file. The memory budget is
the reason this project rejected Next.js; leaving it to a file people copy without reading would
be leaving it to chance. Measured steady state is around 90 MB, so the cap is headroom for a
publish render, and the container limit above it means an error the app reports rather than a
kernel kill that takes its neighbours with it.

**`--chown` on each `COPY`**, never a recursive `chown` afterwards. A recursive chown rewrites
every inode and Docker stores that as a second full copy of `node_modules` — roughly doubling the
image for a metadata change.

**The healthcheck asks for the board**, not for a bespoke `/healthz`. What is being checked is
that a browser would get a page; an endpoint that returns 200 while the board 500s is a green
light on a broken dashboard.

**No shell in front of the entrypoint**, so the server is PID 1 and receives `SIGTERM` directly. A
container that misses it gets `SIGKILL`ed mid-write.

## What CI checks before publishing

The image is built for the runner's own architecture first and actually run: it must serve a
board, seed a data directory whose `.gitignore` already excludes `secrets/` and `state/`, run as a
non-root user, go healthy by its own healthcheck, and stop on `SIGTERM`. Only then is the
multi-architecture build worth several minutes of emulation.

Then it must fit. The ceiling is 90 MB compressed — the number a person on a slow connection
actually waits on.
