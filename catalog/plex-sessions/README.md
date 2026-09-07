# Plex

Who is watching what right now.

## Provenance

Written clean-room from the vendor's own API documentation. No code, descriptor or fixture was
taken from another dashboard project.

- Plex Media Server API (unofficial reference): https://github.com/Arcanemagus/plex-api/wiki

## Endpoint

`GET /status/sessions`

`Accept: application/json` is required; without it Plex answers XML, which no decoder here reads.

## Fixture

`fixtures/sessions.upstream.json` is a JSON response, trimmed to the fields this widget reads. Re-record with `neo catalog test --write`
after changing the projection; the recorded projection is what CI compares against.
