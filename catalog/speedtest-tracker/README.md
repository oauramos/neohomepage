# Speedtest Tracker

The most recent scheduled speed test.

## Provenance

Written clean-room from the vendor's own API documentation. No code, descriptor or fixture was
taken from another dashboard project.

- Speedtest Tracker API: https://docs.speedtest-tracker.dev/api

## Endpoint

`GET /api/v1/results/latest`

## Fixture

`fixtures/latest.upstream.json` is a JSON response. Re-record with `neo catalog test --write`
after changing the projection; the recorded projection is what CI compares against.
