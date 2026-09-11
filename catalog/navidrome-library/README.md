# Navidrome · library

How many songs and folders the library holds, and when it was last scanned.

## Provenance

Written clean-room from the vendor's own API documentation. No code, descriptor or fixture was
taken from another dashboard project.

- Subsonic API, authentication and endpoints: http://www.subsonic.org/pages/api.jsp
- Navidrome's Subsonic compatibility: https://www.navidrome.org/docs/developers/subsonic-api/

## Endpoint

`GET /rest/getScanStatus.view` with the Subsonic query parameters `u`, `s`, `v`, `c` and
`f=json`; the token `t` — `md5(password + salt)` — travels as the `query` auth kind, so the
password itself is never stored anywhere.

## Fixture

`scan.upstream.json` is a recorded response trimmed to the fields this widget reads;
`scan.expected.json` is the projection it must produce and is regenerated with
`pnpm catalog:test -- --write`. `pnpm catalog:test` runs the projection against the fixture with
the network made impossible, so this widget is tested without the service being reachable.
