# Navidrome · playing

Who is listening to what right now.

## Provenance

Written clean-room from the vendor's own API documentation. No code, descriptor or fixture was
taken from another dashboard project.

- Subsonic API, authentication and endpoints: http://www.subsonic.org/pages/api.jsp
- Navidrome's Subsonic compatibility: https://www.navidrome.org/docs/developers/subsonic-api/

## Endpoint

`GET /rest/getNowPlaying.view` with the Subsonic query parameters; the token `t` travels as the
`query` auth kind (see navidrome-library). When nobody is listening, Navidrome answers
`"nowPlaying": {}` — an object, not an empty array — which projects to zero items and a count
of 0 rather than an error.

## Fixtures

`nowPlaying.upstream.json` is a recorded response from a Navidrome 0.63 with two `entry` rows
shaped after the Subsonic API documentation — a fixture cannot wait for someone to press play.
`nowPlaying.expected.json` is the projection it must produce, regenerated with
`pnpm catalog:test -- --write` and compared by `pnpm catalog:test` with the network made
impossible.

`idle.sample.json` is the real idle response (`"nowPlaying": {}`); `navidrome.test.ts` in the
app runs the projection over it and asserts zero items and a count of 0, because that object-
not-array shape is the one that would break a naive projection.
