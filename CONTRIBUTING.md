# Contributing

## The short version

- **A widget is the easiest contribution**, and it is JSON rather than code. Three files, one
  service per pull request. See [the widget reference](https://oauramos.github.io/neohomepage/widgets/).
- **Run `pnpm lint && pnpm typecheck && pnpm test` before opening a PR.** CI runs more than that,
  but those three catch nearly everything.
- **Explain the why in the commit message.** This repository's history is its design document —
  read a few and you will see the shape. What was tried, what broke, why the fix is that one.

## Setting up

Requires Node ≥ 24.15 and pnpm.

```sh
git clone https://github.com/oauramos/neohomepage && cd neohomepage
pnpm install
pnpm dev          # Vite on 5173, the real server on 7575 — open 5173
```

`pnpm dev` writes to `./data`, which is gitignored.

## The checks, and what each is for

| Command             | What breaks if you skip it                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| `pnpm lint`         | The client/server boundary. `src/web` is bundled for a browser and cannot import a Node builtin.  |
| `pnpm typecheck`    | Node's type stripping erases types without checking them, so nothing else would notice.           |
| `pnpm test`         | 470-odd unit tests.                                                                               |
| `pnpm e2e`          | axe, keyboard-only editing, the board with JavaScript off, tap targets. Needs `pnpm build` first. |
| `pnpm catalog:test` | Every widget's projection against its fixtures, with the network made impossible.                 |
| `pnpm budgets`      | First boot, restart and publish latency at 60 widgets.                                            |
| `pnpm drill`        | The restore claim, executed end to end.                                                           |

## Contributing a widget

```
catalog/<slug>/manifest.json                  # the whole integration
catalog/<slug>/fixtures/<name>.upstream.json  # a recorded real response (.ics or .txt if that is the decoder)
catalog/<slug>/fixtures/<name>.expected.json  # written by `pnpm catalog:test -- --write`
catalog/<slug>/README.md                      # which vendor documentation you worked from
```

Then:

```sh
pnpm catalog:test -- --write   # records the expected projection
pnpm --filter @neohomepage/app catalog requires --write   # fills in the derived `requires` block
pnpm catalog:test              # must pass with the network blocked
pnpm catalog:docs              # regenerates docs/widgets/index.md — commit it
```

Three rules, each with a reason:

- **One service per pull request.** A thirty-widget PR cannot have been written from thirty sets
  of vendor documentation, and it cannot be reviewed.
- **Clean room.** Write the manifest from the vendor's own API documentation and cite it in the
  widget's README. gethomepage is GPL-3.0 and this project is MIT; no descriptor, proxy handler or
  icon mapping may come from it, or from any other dashboard.
- **Redact your fixture.** It becomes a public test file. Real filenames, account names and paths
  do not need to be in it.

## Changing the app

A few constraints that are not obvious from the code:

- **`src/web` may not import Node builtins or anything under `src/server`,** except as a type.
  Share through `src/shared`. The lint rule enforces it and a CI job proves the rule fires.
- **Node runs the TypeScript directly by stripping types,** which erases rather than compiles: no
  parameter properties, no enums, no namespaces, and `.tsx` cannot be loaded at all. `src/shared`
  is therefore written with `createElement` rather than JSX.
- **The browser and the MCP server never name a URL, a path, a header or a method.** If a change
  needs one of those to cross that line, it needs a different design.
- **Nothing writes a credential into `config/`.** Routing is decided server-side from the
  manifest. If you are adding a write path, route through the same place.
- **Prefer a test that would have caught the bug** over one that describes the fix.

## Commit messages

Long, and about why. The history is where the reasoning lives — several of the more interesting
decisions in this codebase are only explained in a commit. Say what was tried, what broke, and
what the fix actually buys. No attribution lines.
