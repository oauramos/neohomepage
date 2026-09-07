# Proxmox cluster

How many guests are running across the whole cluster.

## Provenance

Written clean-room from the vendor's own API documentation. No code, descriptor or fixture was
taken from another dashboard project.

- Proxmox VE API: https://pve.proxmox.com/pve-docs/api-viewer/

## Endpoint

`GET /api2/json/cluster/resources` with query `type`

Authenticates with an API key in a request header. Decoded as `json` and projected into the
`stat-grid` template.

## Fixtures

- `fixtures/resources.expected.json`
- `fixtures/resources.upstream.json`

`resources.upstream.*` is a recorded response trimmed to the fields this widget reads;
`resources.expected.json` is the projection it must produce and is regenerated with
`pnpm catalog:test -- --write`. `pnpm catalog:test` runs the projection against the fixture with
the network made impossible, so this widget is tested without the service being reachable.
