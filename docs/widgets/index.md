# Widgets

::: warning Generated
This page is generated from `catalog/*/manifest.json` by `pnpm catalog:docs`. Edit a manifest,
not this file — CI fails if the two disagree.
:::

Every widget here is data: a JSON manifest declaring its fields, its authentication, the one
request it makes and a projection written in a language that cannot loop, recurse or call out.
None of them is a React component, and none of them ships code. That is what makes a catalog
contributed by strangers safe to install.

**16 widgets** covering 5 of 5 presentation templates, 5 of 5 authentication kinds and 3 of 3 response formats.

## Downloads

| Widget | Shows | Needs | Renders as |
| --- | --- | --- | --- |
| **qBittorrent** <br><code>qbittorrent-transfer</code> | transfer | Password <br><small>log in, then a session</small> | `stat-grid` |
| **SABnzbd** <br><code>sabnzbd-queue</code> | queue | API key <br><small>API key in the query string</small> | `list` |

## Information

| Widget | Shows | Needs | Renders as |
| --- | --- | --- | --- |
| **Calendar** <br><code>unified-calendar</code> | 4 source kinds merged into one tile | API key <br><small>API key header, none</small> | `list` |

## Media

| Widget | Shows | Needs | Renders as |
| --- | --- | --- | --- |
| **Jellyfin sessions** <br><code>jellyfin-sessions</code> | sessions | API key <br><small>API key header</small> | `list` |
| **Plex** <br><code>plex-sessions</code> | sessions | X-Plex-Token <br><small>API key header</small> | `list` |

## Media automation

| Widget | Shows | Needs | Renders as |
| --- | --- | --- | --- |
| **Radarr queue** <br><code>radarr-queue</code> | queue | API key <br><small>API key header</small> | `list` |
| **Sonarr queue** <br><code>sonarr-queue</code> | queue | API key <br><small>API key header</small> | `list` |

## Misc

| Widget | Shows | Needs | Renders as |
| --- | --- | --- | --- |
| **Service link** <br><code>service-link</code> | root | no credential <br><small>none</small> | `link-tile` |

## Monitoring

| Widget | Shows | Needs | Renders as |
| --- | --- | --- | --- |
| **Uptime Kuma** <br><code>uptime-kuma-status</code> | heartbeat | no credential <br><small>none</small> | `status-badge` |

## Nas

| Widget | Shows | Needs | Renders as |
| --- | --- | --- | --- |
| **TrueNAS pools** <br><code>truenas-pools</code> | pools | API key <br><small>API key header</small> | `gauge-set` |

## Network

| Widget | Shows | Needs | Renders as |
| --- | --- | --- | --- |
| **AdGuard Home** <br><code>adguard-stats</code> | stats | Password <br><small>username and password</small> | `stat-grid` |
| **Pi-hole** <br><code>pihole-summary</code> | summary | API token <br><small>API key in the query string</small> | `stat-grid` |
| **Speedtest Tracker** <br><code>speedtest-tracker</code> | latest | API token <br><small>API key header</small> | `stat-grid` |

## Virtualization

| Widget | Shows | Needs | Renders as |
| --- | --- | --- | --- |
| **Portainer** <br><code>portainer-containers</code> | containers | Access token <br><small>API key header</small> | `stat-grid` |
| **Proxmox cluster** <br><code>proxmox-cluster</code> | resources | Token secret <br><small>API key header</small> | `stat-grid` |
| **Proxmox node** <br><code>proxmox-node</code> | status | Token secret <br><small>API key header</small> | `gauge-set` |

## Adding one

A widget is three files and no code:

```
catalog/<slug>/manifest.json                 # the whole integration
catalog/<slug>/fixtures/<name>.upstream.*    # a recorded real response
catalog/<slug>/fixtures/<name>.expected.json # the projection it must produce
catalog/<slug>/README.md                     # which vendor documentation you worked from
```

The fixture's extension follows the decoder: `.json`, `.ics` or `.txt`. It is read through the
real decoder, so an iCalendar fixture exercises recurrence expansion and timezone conversion
offline rather than being a hand-written guess at what the decoder emits.

```sh
pnpm catalog:validate    # schema, limits, and the derived-vs-declared `requires` check
pnpm catalog:test        # runs every projection against its fixtures, with no network
```

`catalog:test` does not merely avoid the network — it makes `fetch` throw. A widget whose test
only passes while your LAN is up is a broken widget, and the difference is invisible otherwise.

`requires` is **derived from the manifest and compared to what you declared**; a hand-maintained
requirement list drifts within weeks, and that drift is exactly the "installs fine, then renders
nothing" bug. Run `pnpm --filter @neohomepage/app catalog requires --write` to fill it in.

One service per pull request. A thirty-widget PR cannot have been written from thirty sets of
vendor documentation, and it cannot be reviewed.

## Widgets that bind several services

Most widgets bind one target. A **composite** widget binds several, of possibly different kinds,
and merges them into one tile — the calendar above is the example. It replaces
`target`/`operations`/`projection` with:

- `roles` — the binding slots, each naming which target shapes it accepts and how many.
- `compose` — how the merged streams become one list: distinct, sort, limit, and whether a
  partial answer still renders.

Inside a role, each accepted kind declares its own fields, its own authentication and **one**
operation with one or more `emits`. Several emits over one response is how Radarr contributes
three dated events per film — in cinemas, physical, digital — from a single HTTP request.
