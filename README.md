# neohomepage

A self-hosted start page for your homelab that you configure **in the browser** — not by editing
YAML and restarting a container.

> Beta. Everything below works; there is no published container tag yet, so install from source
> or build the image yourself. See [the roadmap](#roadmap).

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

Open <http://localhost:5173> and add a service from the button in the bottom-left corner. Or with
Docker, once a release is tagged:

```sh
curl -O https://raw.githubusercontent.com/oauramos/neohomepage/main/compose.yaml
docker compose up -d
```

See [docs/install.md](docs/install.md) for the full guide and
[docs/guide/backup.md](docs/guide/backup.md) for how backup and restore work.

```sh
pnpm lint            # eslint, including the client/server boundary rule
pnpm typecheck
pnpm test            # 469 unit tests
pnpm e2e             # 28 browser tests: axe, keyboard-only editing, no-JS, tap targets
pnpm catalog:test    # every widget's projection against its fixtures, with the network blocked
pnpm budgets         # cold start and publish latency at 60 widgets
pnpm drill           # the restore claim, executed: commit, clone, boot, compare
pnpm build
pnpm docs:dev        # the documentation site
```

`pnpm --filter @neohomepage/app neo --help` lists the command line surface. Every capability the UI
gets must be reachable there first — that is what keeps each phase testable without a browser.
`neo doctor` explains anything that is wrong with an install and exits non-zero if it matters.

## What is checked, and how

Claims about this kind of software are cheap, so the ones this project makes are executable:

| Claim | The check |
| --- | --- |
| Widgets cannot drift from their forms | `requires` is derived from each manifest and compared to what the author declared |
| A widget works offline | `catalog:test` makes `fetch` **throw**, not merely go unused |
| The catalog covers what it claims | a coverage footer: templates 5/5, auth kinds 5/5, decoders 3/3 |
| Two builds are identical | CI builds the catalog twice and compares the bytes |
| The board works without JavaScript | a Playwright profile with JS disabled |
| The editor works without a mouse | a fixture that makes `page.mouse` throw |
| The theme meets WCAG AA | every text token against every surface, as colour maths |
| It fits on a 1 GB box | an hour-long soak on real arm64 under a 1 GiB cgroup |
| Restore actually restores | commit `/data`, clone it, boot with the key in the environment, compare hashes |
| Nothing needed changing for Docker | `git diff f12..HEAD -- 'packages/*/src/'` prints nothing |

## Roadmap

F0–F13 are done: the workspace, the arm64 memory experiment, the layout engine, the projection
DSL, the config kernel, the SSRF-safe fetcher, the poll scheduler, publishing, the SPA and
templates, the editor, auth and MCP, the catalog and its sixteen widgets, accessibility and
hardening, and — last, on purpose — the container.

Next: run the widgets against real hardware, publish a release, and the deliberately post-1.0
list — a gethomepage compatibility report, Docker label discovery, multiple pages, OIDC, and write
actions, which turn the egress posture from read-only to mutating and need their own threat model.

## Licence and attribution

MIT. neohomepage is a clean-room implementation — gethomepage is GPL-3.0 and no code from it is
used here. Widget manifests are written from each vendor's own API documentation.
