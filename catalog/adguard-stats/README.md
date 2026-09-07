# AdGuard Home

Queries seen today and the share of them blocked.

## Provenance

Written clean-room from the vendor's own API documentation. No code, descriptor or fixture was
taken from another dashboard project.

- AdGuard Home API: https://github.com/AdguardTeam/AdGuardHome/tree/master/openapi

## Endpoint

`GET /control/stats`

Authenticates with a username and password (HTTP basic). Decoded as `json` and projected into the
`stat-grid` template.

## Fixtures

- `fixtures/stats.expected.json`
- `fixtures/stats.upstream.json`

`stats.upstream.*` is a recorded response trimmed to the fields this widget reads;
`stats.expected.json` is the projection it must produce and is regenerated with
`pnpm catalog:test -- --write`. `pnpm catalog:test` runs the projection against the fixture with
the network made impossible, so this widget is tested without the service being reachable.
