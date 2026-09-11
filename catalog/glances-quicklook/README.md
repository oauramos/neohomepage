# Glances · host

CPU, memory, swap and load of one host, as Glances sees it.

## Provenance

Written clean-room from the vendor's own API documentation. No code, descriptor or fixture was
taken from another dashboard project.

- Glances RESTful API (v4): https://glances.readthedocs.io/en/latest/api.html

## Endpoint

`GET /api/4/quicklook`

The four percentages Glances puts in its own "quick look" bar. `load` is Glances' load percentage
(five-minute load over core count); it is clamped to 100 so a runaway box fills the bar rather
than overflowing it. No credential: a stock Glances server takes none. If yours runs with
`--password`, that is a follow-up.

## Fixture

`quicklook.upstream.json` is a recorded response trimmed to the fields this widget reads;
`quicklook.expected.json` is the projection it must produce and is regenerated with
`pnpm catalog:test -- --write`. `pnpm catalog:test` runs the projection against the fixture with
the network made impossible, so this widget is tested without the service being reachable.
