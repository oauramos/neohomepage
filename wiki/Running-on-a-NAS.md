# Running on a NAS

Almost everything that goes wrong on a NAS is file ownership. The rest is the container manager's
user interface hiding a setting you need.

## Your user id is probably not 1000

Synology and QNAP hand out ids starting well above 1000, and Unraid runs everything as `99:100`.
The image defaults to `1000:1000` and takes ownership of the data directory on first boot, which
works — but then the files belong to a user your NAS's file manager does not show, and you cannot
open the backup folder over SMB.

Set them explicitly:

```yaml
environment:
  PUID: 1026 # id -u yourname, over SSH
  PGID: 100 # id -g yourname
```

Find them with `id yourname` in a terminal. On Synology, `users` is group `100`; on Unraid the
convention is `99:100`.

The entrypoint creates that user inside the container and runs the server as it, so the files it
writes are yours.

## Synology (DSM 7)

Container Manager can import a `compose.yaml` — Project → Create → _Upload docker-compose.yml_.
That is much less painful than the GUI form, and it keeps the capability settings the file
specifies, which the form does not expose.

- Put the data directory somewhere on a **volume**, not in `/tmp` or `/volume1/docker` if you have
  not created it: `/volume1/docker/neohomepage/data` is the convention.
- DSM occupies ports 5000 and 5001. 7575 is free by default.
- If you reach the NAS through DSM's reverse proxy, add the entry with **WebSocket enabled** — the
  live updates are Server-Sent Events, and a proxy that buffers them makes the dashboard look
  frozen while working perfectly on a direct connection.

## QNAP (Container Station)

Container Station's compose support is on the _Applications_ tab. Same PUID/PGID advice.

QNAP's own web interface takes 8080 and 443. 7575 is free.

## Unraid

There is no template in Community Applications. Add it as a custom container:

| Field      | Value                                     |
| ---------- | ----------------------------------------- |
| Repository | `ghcr.io/oauramos/neohomepage:latest`     |
| Network    | `bridge`                                  |
| Port       | `7575` → `7575`                           |
| Path       | `/mnt/user/appdata/neohomepage` → `/data` |
| Variable   | `PUID` = `99`                             |
| Variable   | `PGID` = `100`                            |

Unraid's `appdata` share should be **cache-preferred**; the dashboard republishes on every edit
and you do not want that spinning up an array disk.

## Backing it up from the NAS

The data directory is a git repository or it is nothing. From SSH:

```sh
cd /volume1/docker/neohomepage/data
git init && git add -A && git commit -m "my dashboard"
git remote add origin git@github.com:you/neohomepage-data.git
git push -u origin main
```

`secrets/` and `state/` are already excluded — the app writes that `.gitignore` on first boot,
before either directory has anything in it.

Keep the credentials themselves in the compose file as `NEOHOMEPAGE_SECRET_*` variables. Then the
repository can be public, and restoring on a new NAS is `git clone` plus that one file.

## Memory

320 MB is generous: measured resident is around 46 MB idle. If your NAS is doing other work, the
limit is what stops a runaway from taking the rest of the box with it, so leave it in.

Do not raise `NODE_OPTIONS=--max-old-space-size` to "give it more room". It is set to 192 MB
deliberately, and a heap that grows past that is a bug worth reporting rather than a resource
problem.
