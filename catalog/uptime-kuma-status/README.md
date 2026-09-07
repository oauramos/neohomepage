# Uptime Kuma

Whether the monitors on a status page are up.

## Provenance

Written clean-room from the vendor's own API documentation. No code, descriptor or fixture was
taken from another dashboard project.

- Uptime Kuma status page endpoint, read from its own web client

## Endpoint

`GET /api/status-page/heartbeat/{{config:slug}}`

No credential. Decoded as `json` and projected into the
`status-badge` template.

## Fixtures

- `fixtures/heartbeat.expected.json`
- `fixtures/heartbeat.upstream.json`

`heartbeat.upstream.*` is a recorded response trimmed to the fields this widget reads;
`heartbeat.expected.json` is the projection it must produce and is regenerated with
`pnpm catalog:test -- --write`. `pnpm catalog:test` runs the projection against the fixture with
the network made impossible, so this widget is tested without the service being reachable.
