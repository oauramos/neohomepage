# Portainer

How many containers are up, and how many are not.

## Provenance

Written clean-room from the vendor's own API documentation. No code, descriptor or fixture was
taken from another dashboard project.

- Portainer API: https://docs.portainer.io/api/access

## Endpoint

`GET /api/endpoints/{id}/docker/containers/json?all=true`

The environment id is a typed integer config field interpolated into the path template and
percent-encoded, so it cannot become a second path segment.

## Fixture

`fixtures/containers.upstream.json` is a JSON response, trimmed to the fields this widget reads. Re-record with `neo catalog test --write`
after changing the projection; the recorded projection is what CI compares against.
