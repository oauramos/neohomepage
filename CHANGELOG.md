# Changelog

## 0.1.0 — first release

The first tagged release. Beta: everything below works and has a check that proves it, but this
has not yet run for a month on someone else's hardware.

### What it is

A self-hosted start page you configure in the browser rather than by editing YAML. One Node
process, no database, ~46 MB resident, a 59 MB image. The dashboard is rendered to static HTML and
served from disk, so the page works with JavaScript disabled and the editor is loaded only when
you open it.

### What is in it

- **Sixteen widgets**, covering all five presentation templates, all five authentication kinds and
  all three response decoders — a coverage footer that CI now enforces rather than prints.
  Sonarr, Radarr, Lidarr, Jellyfin, Plex, qBittorrent, SABnzbd, Pi-hole, AdGuard Home, Uptime
  Kuma, Speedtest Tracker, Proxmox (cluster and node), TrueNAS, Portainer, a unified calendar and
  a link tile.
- **The unified calendar**, which binds any mix of *arr instances and iCalendar feeds into one
  agenda. Recurrence expansion, `EXDATE`, moved instances and timezone conversion happen in the
  decoder; all-day events are anchored at UTC so a feed reads the same everywhere.
- **The editor**: drag and drop, a form generated from each widget's manifest, theming, a
  background, and "test connection" against the real service before you save.
- **An MCP server** so an AI can add and configure widgets. It cannot read a credential, write
  custom CSS or JavaScript, or name a URL — those three are permanently absent.
- **Backup as a git repository.** `config/` and `assets/` are committed; `secrets/` and `state/`
  are excluded by a `.gitignore` written on first boot. Restoring is `git clone` plus your
  credentials in the environment, and CI executes exactly that on every push.
- **`neo doctor`**, which explains what is wrong with an install and exits non-zero when it
  matters.

### Running it

```sh
mkdir neohomepage && cd neohomepage
curl -O https://raw.githubusercontent.com/oauramos/neohomepage/main/compose.yaml
docker compose up -d
```

`linux/amd64` and `linux/arm64`, each built on a runner that natively is that architecture.

### Known gaps

- **One page.** The configuration has carried `pages[]` from the start so it will not be a
  migration, but there is no UI for it.
- **Pi-hole v6 is not supported.** The bundled widget targets v5's `/admin/api.php`; v6 replaced
  the API with a session exchange. It returns `http-404` or `bad-json` on v6.
- **iCalendar feeds needing a username and password** are not supported. A token in the URL works,
  because that is part of the path you supply.
- **No catalog auto-update yet.** The widget catalog ships in the image and is served at
  `/catalog/v1/`, but installs do not pull from it on their own.
- **Not soaked on a NAS.** The hour-long memory soak ran on arm64 under a 1 GiB cgroup; real
  hardware over real time is the next thing.

### For anyone reading the history

The commit messages are the design document, and several decisions are only explained there. The
ones worth reading first are the four in F13 about the container, and the two about measurement
gates that were passing for the wrong reasons.
