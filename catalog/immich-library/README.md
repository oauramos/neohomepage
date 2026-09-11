# Immich

How many photos and videos the library holds, and the space they take.

## Provenance

Written clean-room from the vendor's own API documentation. No code, descriptor or fixture was
taken from another dashboard project.

- Immich API, server statistics: https://immich.app/docs/api/get-server-statistics

## Endpoint

`GET /api/server/statistics` with the key in `x-api-key`. The key needs the
`server.statistics` permission when Immich's scoped keys are in use; a key without it answers
403, which the tile reports as `http-403` rather than as a broken library.

## Fixture

`statistics.upstream.json` is a recorded response trimmed to the fields this widget reads;
`statistics.expected.json` is the projection it must produce and is regenerated with
`pnpm catalog:test -- --write`. `pnpm catalog:test` runs the projection against the fixture with
the network made impossible, so this widget is tested without the service being reachable.
The recorded response also carried a per-user breakdown with names; it is not read and was removed.
