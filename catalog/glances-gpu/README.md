# Glances · GPU

Load, memory and temperature of the first GPU Glances sees.

## Provenance

Written clean-room from the vendor's own API documentation. No code, descriptor or fixture was
taken from another dashboard project.

- Glances RESTful API (v4): https://glances.readthedocs.io/en/latest/api.html

## Endpoint

`GET /api/4/gpu`

An array, one entry per GPU; this widget reads the first. `proc` and `mem` are percentages,
`temperature` is Celsius. A host with no GPU plugin answers an empty array and the tile shows
dashes rather than an error, which is the honest reading for "nothing to report".

## Fixture

`gpu.upstream.json` is a recorded response trimmed to the fields this widget reads;
`gpu.expected.json` is the projection it must produce and is regenerated with
`pnpm catalog:test -- --write`. `pnpm catalog:test` runs the projection against the fixture with
the network made impossible, so this widget is tested without the service being reachable.
