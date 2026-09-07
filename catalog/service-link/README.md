# Service link

A bookmark tile: a link to a service, with the whole tile as the target.

## Provenance

Written clean-room from the vendor's own API documentation. No code, descriptor or fixture was
taken from another dashboard project.

- None — this widget calls no vendor API

## Endpoint

`GET /`

No credential. Decoded as `text` and projected into the
`link-tile` template.

## Fixtures

- `fixtures/root.expected.json`
- `fixtures/root.upstream.txt`

`root.upstream.*` is a recorded response trimmed to the fields this widget reads;
`root.expected.json` is the projection it must produce and is regenerated with
`pnpm catalog:test -- --write`. `pnpm catalog:test` runs the projection against the fixture with
the network made impossible, so this widget is tested without the service being reachable.
