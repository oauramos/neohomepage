/**
 * The board the README demos are recorded against: every tile is a real widget rendering its own
 * `catalog/<slug>/fixtures/<op>.upstream.json` through the real fetcher, served by one stub per
 * widget.
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
 * Values and config each widget's target needs to be well-formed; the "demo" secrets reach a local
 * stub that never checks them.
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
