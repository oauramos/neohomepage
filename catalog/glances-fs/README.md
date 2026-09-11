# Glances · disks

Every mounted filesystem as a bar: used over size.

## Provenance

Written clean-room from the vendor's own API documentation. No code, descriptor or fixture was
taken from another dashboard project.

- Glances RESTful API (v4): https://glances.readthedocs.io/en/latest/api.html

## Endpoint

`GET /api/4/fs`

One gauge per mount point, in the order Glances lists them, up to eight. Sizes are bytes, so the
bar reads the same for a 100 GB root and a 4 TB media pool.

## Fixture

`fs.upstream.json` is a recorded response trimmed to the fields this widget reads;
`fs.expected.json` is the projection it must produce and is regenerated with
`pnpm catalog:test -- --write`. `pnpm catalog:test` runs the projection against the fixture with
the network made impossible, so this widget is tested without the service being reachable.
