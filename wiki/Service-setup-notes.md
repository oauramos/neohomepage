# Service setup notes

Where each service hides its key, and the one field per service that is easy to get wrong. The
editor shows most of this as help text — this page is for the bits that need a sentence rather
than a line.

For what each widget _displays_, see the
[widget reference](https://oauramos.github.io/neohomepage/widgets/), which is generated from the
manifests and therefore cannot be out of date.

---

## Sonarr, Radarr, Lidarr

**Settings → General → API Key.** Same shape for all three. The port is usually 8989, 7878 and
8686 respectively.

If you run them behind a reverse proxy on a subpath (`/sonarr`), put that subpath in the **Path**
field when adding the service — not in the host. The manifest owns the rest of the URL and will
refuse to dial anything it did not compute.

All three can also be bound into the **Calendar** widget, which merges them with any number of
iCalendar feeds into one agenda. Radarr contributes up to three entries per film — in cinemas,
physical, digital — from a single request.

## Pi-hole

**Settings → API → Show API token.** The token goes in the query string, because Pi-hole v5 offers
nothing else; it is never logged and never reaches your browser.

Pi-hole **v6 changed its API completely** — it authenticates by exchanging a password for a
session. The bundled widget targets v5's `/admin/api.php`. If you are on v6 and it returns
`http-404` or `bad-json`, that is why; please say so on an issue so a v6 manifest gets written.

## AdGuard Home

Username and password, the same pair you log into the web interface with. Basic auth, so if you
have put AdGuard behind another basic-auth proxy the two will collide.

## Jellyfin

**Dashboard → API Keys → +.** A key is per-application, so make one for this rather than reusing
another tool's.

## Plex

The token is not in a settings page. Easiest: open any item in the Plex web app and read
`X-Plex-Token` out of the URL. Or Settings → Network → Show Advanced.

## qBittorrent

The Web UI username and password — **Options → Web UI**, not your tracker account. This is the one
service here that logs in and carries a session cookie, so a few things follow from that:

- If you have enabled _Bypass authentication for clients on localhost_, this still authenticates
  normally, which is fine.
- qBittorrent counts concurrent sessions and starts refusing when there are too many. Every widget
  pointed at the same instance with the same credential shares one login, so this is not usually
  a problem — but if you also have other tools polling it, it can be.
- A wrong password shows as `http-403` after one automatic retry, not as a login error. The retry
  is deliberately capped at one: qBittorrent bans an IP after repeated failures.

## SABnzbd

**Config → General → API Key.** The full key, not the NZB key — the NZB key can only add
downloads, and reading the queue with it returns an error rather than a permission message.

## Proxmox VE

**Datacenter → Permissions → API Tokens.** You need two values and they are easy to mix up:

- **Token ID** — the whole `user@realm!tokenname` string, e.g. `root@pam!neohomepage`.
- **Token secret** — the UUID shown once when you create it. If you did not copy it, make another.

Uncheck **Privilege Separation** or grant the token `PVEAuditor` on `/`, or every request returns
an empty list rather than an error.

The **node** widget also needs the node's name as it appears in the Proxmox tree (`pve`, `pve1`) —
not its hostname, which is often different.

Proxmox uses a self-signed certificate by default. Either add it to the service's TLS settings or
use `http` on port 8006 if you have it enabled; there is a per-service option to skip verification
and it applies only to that service.

## TrueNAS

**Credentials → API Keys.** SCALE and CORE both expose `/api/v2.0`, so one manifest covers both.

## Portainer

**My account → Access tokens.** The widget also needs the **Environment ID** — the number in the
URL when you open an environment, `1` on a single-host install.

## Uptime Kuma

No credential. It needs the **slug of a status page**, not a monitor: create a status page, add the
monitors you care about, and use the slug from its URL. A private status page will not work — the
endpoint the widget reads is the public one.

## Speedtest Tracker

**Settings → API tokens.** A Bearer token. The widget reads only the most recent result, so set
the schedule in Speedtest Tracker itself; polling this more often than it tests achieves nothing.

## iCalendar feeds

No credential, and the feed's **whole path goes in the Path field** — `/dav/calendars/user/home.ics`
and the like. This is the one place a path belongs to you rather than to a manifest.

Feeds that authenticate with a token in the URL work, because the token is part of the path you
supply. Feeds that need a username and password do not yet — please open an issue if you have one.

Recurring events are expanded to real occurrences, `EXDATE` and moved instances are honoured, and
all-day events are anchored at UTC so the same feed reads the same everywhere.
