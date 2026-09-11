# Glances · sensors

Temperatures a host reports, one line each.

## Provenance

Written clean-room from the vendor's own API documentation. No code, descriptor or fixture was
taken from another dashboard project.

- Glances RESTful API (v4): https://glances.readthedocs.io/en/latest/api.html

## Endpoint

`GET /api/4/sensors`

Every entry whose unit is Celsius — core temperatures, drives, batteries with a thermistor — as
a list of label and reading, up to twelve. Fan speeds and battery percentages are in the same
array under other units and are left out on purpose: they need a different scale.

## Fixture

`sensors.upstream.json` is a recorded response trimmed to the fields this widget reads;
`sensors.expected.json` is the projection it must produce and is regenerated with
`pnpm catalog:test -- --write`. `pnpm catalog:test` runs the projection against the fixture with
the network made impossible, so this widget is tested without the service being reachable.
