/**
 * The board the README demos are recorded against.
 *
 * Every tile is a real widget rendering its own recorded upstream fixture — the same JSON the
 * catalog tests assert against — through the real fetcher, decoder, projection and template. The
 * only thing standing in for a homelab is the socket at the other end: one stub per widget,
 * answering that widget's operation with `catalog/<slug>/fixtures/<op>.upstream.json`.
 *
 * That constraint is the point. A demo assembled from mockups drifts from the product the first
 * time a template changes and nobody notices; this one cannot, because a projection that stops
 * producing what the template needs makes the recording visibly wrong.
 */

/** Twelve columns at the `lg` tier, rows of 56px with 12px gutters. */
export const TILES = [
  { slug: 'speedtest-tracker', title: 'Speedtest', x: 0, y: 0, w: 4, h: 3 },
  { slug: 'adguard-stats', title: 'AdGuard Home', x: 4, y: 0, w: 4, h: 3 },
  { slug: 'pihole-summary', title: 'Pi-hole', x: 8, y: 0, w: 4, h: 3 },

  { slug: 'sonarr-queue', title: 'Sonarr', x: 0, y: 3, w: 4, h: 4 },
  { slug: 'radarr-queue', title: 'Radarr', x: 4, y: 3, w: 4, h: 4 },
  { slug: 'proxmox-node', title: 'proxmox-01', x: 8, y: 3, w: 4, h: 4 },

  { slug: 'jellyfin-sessions', title: 'Jellyfin', x: 0, y: 7, w: 4, h: 3 },
  { slug: 'truenas-pools', title: 'TrueNAS', x: 4, y: 7, w: 4, h: 3 },
  { slug: 'qbittorrent-transfer', title: 'qBittorrent', x: 8, y: 7, w: 4, h: 3 },
]

/**
 * What each widget's target and config need to be well-formed.
 *
 * The secrets are the string "demo" on purpose and reach a socket on this machine that ignores
 * them — there is no credential here to leak into a recording, and the stub is deliberately not
 * checking, so a failure in this script can never be mistaken for an auth failure.
 */
export const VALUES = {
  'adguard-stats': { values: { username: 'demo', password: 'demo' } },
  'jellyfin-sessions': { values: { apiKey: 'demo' } },
  'pihole-summary': { values: { apiKey: 'demo' } },
  'portainer-containers': { values: { apiKey: 'demo' }, config: { endpointId: 1 } },
  'proxmox-node': {
    values: { tokenId: 'demo@pam!demo', token: 'demo' },
    config: { node: 'proxmox-01' },
  },
  'qbittorrent-transfer': { values: { username: 'demo', password: 'demo' } },
  'radarr-queue': { values: { apiKey: 'demo' }, config: { maxItems: 4 } },
  'service-link': { values: {}, config: { label: 'Grafana', path: '/' } },
  'sonarr-queue': { values: { apiKey: 'demo' }, config: { maxItems: 4 } },
  'speedtest-tracker': { values: { apiKey: 'demo' } },
  'truenas-pools': { values: { apiKey: 'demo' } },
  'uptime-kuma-status': { values: {}, config: { slug: 'homelab' } },
}
