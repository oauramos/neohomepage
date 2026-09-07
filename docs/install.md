# Install

::: warning
Pre-release. The Docker image is deliberately the _last_ thing built — everything is validated
running locally first. For now, install from source.
:::

## From source

```sh
git clone https://github.com/oauramos/neohomepage
cd neohomepage
pnpm install
pnpm dev
```

`pnpm dev` starts two processes: the Vite dev server on <http://localhost:5173> (with hot reload)
and the real server on port 7575. Open 5173 — it proxies `/api` to the server, so the topology
matches production, where a single process serves everything.

## Where your data lives

Everything the app owns lives under one directory, so backing it up is one `git init`:

| Directory  | Committed? | What it is                                                |
| ---------- | ---------- | --------------------------------------------------------- |
| `config/`  | yes        | Layout, widgets, targets, theme. Never contains a secret. |
| `assets/`  | yes        | Backgrounds, local icons, fonts.                          |
| `secrets/` | **no**     | API keys, `0600`. Never goes to git, not even encrypted.  |
| `state/`   | **no**     | Caches and rendered pages. Delete it and it rebuilds.     |

The default is `./data` when running from source, and `/data` in the container image. Override with
`NEOHOMEPAGE_DATA_DIR`, or point any single directory somewhere else with `NEOHOMEPAGE_CONFIG_DIR`,
`NEOHOMEPAGE_ASSETS_DIR`, `NEOHOMEPAGE_SECRETS_DIR`, `NEOHOMEPAGE_STATE_DIR`.

Useful commands (all take `NEOHOMEPAGE_DATA_DIR`):

```sh
pnpm --filter @neohomepage/app neo env       # print the resolved paths
pnpm --filter @neohomepage/app neo init      # create and seed the data directory
pnpm --filter @neohomepage/app neo validate  # check the config tree
pnpm --filter @neohomepage/app neo backup    # write a restorable archive
```

The server seeds the data directory on first boot too, so `neo init` is only needed if you want
the folder set up before starting anything.

See [Backup and restore](/guide/backup) for the full story, including how API keys survive a wipe
without ever entering the repository.
