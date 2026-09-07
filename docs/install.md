# Install

::: warning Pre-release
The container image is built by CI on a tagged release; there is no published tag yet. Until there
is, use the source install below — it is the same code the image runs, because the image ships the
sources rather than a compiled bundle.
:::

## Docker

One directory, one port, one file:

```sh
mkdir neohomepage && cd neohomepage
curl -O https://raw.githubusercontent.com/oauramos/neohomepage/main/compose.yaml
docker compose up -d
```

Open `http://<this-host>:7575` and add a service from the button in the bottom-left corner.
Nothing in `compose.yaml` needs editing to add a widget — that is the point of the project.

The container runs unprivileged, read-only apart from `/data`, with no capabilities and a 320 MB
memory limit. It is one process: no database, no Redis, no sidecar.

### The two things worth setting

**A password**, if the machine is reachable by anyone you would not hand the editor to. Reads stay
open; writes need it.

```yaml
environment:
  NEOHOMEPAGE_USERNAME: neo
  NEOHOMEPAGE_PASSWORD: at-least-eight-characters
```

**Your service credentials**, as environment variables rather than in the data directory:

```yaml
environment:
  NEOHOMEPAGE_SECRET_T3A91F_APIKEY: your-sonarr-api-key
```

You do not have to — entering a key in the editor stores it in `secrets/`, which is gitignored and
`0600`. But keeping them here is what makes restoring a `git clone` and this file, with the
repository never having seen a key. `neo doctor` prints the exact variable name for every
credential it cannot find. See [Backup and restore](/guide/backup).

### Running it directly

```sh
docker run -d --name neohomepage \
  -p 7575:7575 -v "$PWD/data:/data" \
  --memory 320m --restart unless-stopped \
  ghcr.io/oauramos/neohomepage:latest
```

Images are published for `linux/amd64` and `linux/arm64`, because the box this is for is as often
a Pi-class Proxmox container or a NAS as it is a server.

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
