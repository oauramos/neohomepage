# Jellyfin

Who is watching what right now.

## Provenance

Written clean-room from the vendor's own API documentation. No code, descriptor or fixture was
taken from another dashboard project.

- Jellyfin API: https://api.jellyfin.org/

## Endpoint

`GET /Sessions` with query `activeWithinSeconds`

Authenticates with an API key in a request header. Decoded as `json` and projected into the
`list` template.

## Fixtures

- `fixtures/sessions.expected.json`
- `fixtures/sessions.upstream.json`

`sessions.upstream.*` is a recorded response trimmed to the fields this widget reads;
`sessions.expected.json` is the projection it must produce and is regenerated with
`pnpm catalog:test -- --write`. `pnpm catalog:test` runs the projection against the fixture with
the network made impossible, so this widget is tested without the service being reachable.
