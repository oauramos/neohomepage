# neohomepage

A self-hosted start page for your homelab that you configure **in the browser** — not by editing
YAML and restarting a container.

> Early development. See the [roadmap](#roadmap) for what works today.

## Why

[gethomepage](https://gethomepage.dev) has ~160 service integrations and no way to add one without
editing a YAML file. [Homarr](https://homarr.dev) has a real visual editor and ~40 integrations,
and wants Redis, SQLite and roughly 500 MB of RAM. Nobody combines the integration breadth of the
first with the editing experience of the second, in something that fits a 1 GB box.

## What it does

- **Edit everything from the UI.** A button in the bottom-left corner opens the editor: drag
  widgets around, change the theme, set a background, add a service by filling in a form.
- **Your data is a folder of JSON.** `git init` it, push it, and restoring is `git clone`.
- **Small.** One Node process, no database, no bundler on the box. The dashboard is rendered to
  static HTML and served from disk.
- **Widgets are data, not code.** Each integration is a JSON manifest — the edit form, the MCP
  tool schema, the proxy allowlist and the docs are all derived from it, so they cannot drift.
- **Configurable by an AI.** A built-in MCP server lets Claude, Codex or any MCP client add
  widgets and targets for you.

## Security posture

The browser and the MCP server **never name a URL, path, header or HTTP method**. The client asks
to refresh a widget by id; the server resolves instance → target → manifest → a literal path
template, then asserts the resulting origin and pathname match exactly. Only the fields a manifest
declares are ever returned — the raw upstream response is discarded before it reaches a cache.

Secrets live in their own directory, `0600`, and never enter the git-synced config — the writer has
no code path that would put one there.

## Getting started

Requires Node >= 24.15 and pnpm (installed automatically via the `packageManager` field).

```sh
pnpm install
pnpm dev
```

Open <http://localhost:5173>. See [docs/install.md](docs/install.md) for the full guide and
[docs/guide/backup.md](docs/guide/backup.md) for how backup and restore work.

```sh
pnpm lint         # eslint, including the client/server boundary rule
pnpm typecheck
pnpm test
pnpm build
pnpm docs:dev     # the documentation site
```

`pnpm --filter @neohomepage/app neo --help` lists the command line surface. Every capability the UI
gets must be reachable there first — that is what keeps each phase testable without a browser.

## Roadmap

Phase F0 (this) is the skeleton. What follows, in order: an ARM64 memory experiment on real
hardware, the layout engine, the projection DSL, the config kernel, the SSRF-safe fetcher, the poll
scheduler, publishing, the SPA and templates, the editor, auth and MCP, the catalog and widgets,
accessibility, and only then Docker. Docker is deliberately last: nothing ships until it has been
validated running locally.

## Licence and attribution

MIT. neohomepage is a clean-room implementation — gethomepage is GPL-3.0 and no code from it is
used here. Widget manifests are written from each vendor's own API documentation.
