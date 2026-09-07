# TrueNAS pools

Capacity used per storage pool.

## Provenance

Written clean-room from the vendor's own API documentation. No code, descriptor or fixture was
taken from another dashboard project.

- TrueNAS API: https://www.truenas.com/docs/api/

## Endpoint

`GET /api/v2.0/pool`

Authenticates with an API key in a request header. Decoded as `json` and projected into the
`gauge-set` template.

## Fixtures

- `fixtures/pools.expected.json`
- `fixtures/pools.upstream.json`

`pools.upstream.*` is a recorded response trimmed to the fields this widget reads;
`pools.expected.json` is the projection it must produce and is regenerated with
`pnpm catalog:test -- --write`. `pnpm catalog:test` runs the projection against the fixture with
the network made impossible, so this widget is tested without the service being reachable.
