# Sonarr

The download queue, with what is left to fetch.

## Provenance

Written clean-room from the vendor's own API documentation. No code, descriptor or fixture was
taken from another dashboard project.

- Sonarr API: https://sonarr.tv/docs/api/

## Endpoint

`GET /api/v3/queue` with query `pageSize`, `includeSeries`

Authenticates with an API key in a request header. Decoded as `json` and projected into the
`list` template.

## Fixtures

- `fixtures/queue.expected.json`
- `fixtures/queue.upstream.json`

`queue.upstream.*` is a recorded response trimmed to the fields this widget reads;
`queue.expected.json` is the projection it must produce and is regenerated with
`pnpm catalog:test -- --write`. `pnpm catalog:test` runs the projection against the fixture with
the network made impossible, so this widget is tested without the service being reachable.
