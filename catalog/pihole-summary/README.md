# Pi-hole

Queries seen today and the share of them blocked.

## Provenance

Written clean-room from the vendor's own API documentation. No code, descriptor or fixture was
taken from another dashboard project.

- Pi-hole API (v5): https://discourse.pi-hole.net/t/pi-hole-api/1863

## Endpoint

`GET /admin/api.php` with query `summaryRaw`

Authenticates with an API key in the query string, because the service offers no header form. It is never logged and never reaches the browser. Decoded as `json` and projected into the
`stat-grid` template.

## Fixtures

- `fixtures/summary.expected.json`
- `fixtures/summary.upstream.json`

`summary.upstream.*` is a recorded response trimmed to the fields this widget reads;
`summary.expected.json` is the projection it must produce and is regenerated with
`pnpm catalog:test -- --write`. `pnpm catalog:test` runs the projection against the fixture with
the network made impossible, so this widget is tested without the service being reachable.
