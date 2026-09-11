# Nextcloud

Who is on, how many users and files there are, and how much space is left.

## Provenance

Written clean-room from the vendor's own API documentation. No code, descriptor or fixture was
taken from another dashboard project.

- Nextcloud server info app (OCS API): https://github.com/nextcloud/serverinfo#api
- OCS request header: https://docs.nextcloud.com/server/latest/developer_manual/client_apis/OCS/ocs-api-overview.html

## Endpoint

`GET /ocs/v2.php/apps/serverinfo/api/v1/info?format=json` with the `OCS-APIRequest: true` header
the OCS API requires, authenticated with HTTP Basic — an admin account and an app password made
for this dashboard, never the account's own password.

## Fixture

`info.upstream.json` is a recorded response trimmed to the fields this widget reads;
`info.expected.json` is the projection it must produce and is regenerated with
`pnpm catalog:test -- --write`. `pnpm catalog:test` runs the projection against the fixture with
the network made impossible, so this widget is tested without the service being reachable.
