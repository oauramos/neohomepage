# qBittorrent

Transfer rates and totals from the qBittorrent Web UI.

## Provenance

Written clean-room from the vendor's own API documentation. No code, descriptor or fixture was
taken from another dashboard project.

- qBittorrent Web API: https://github.com/qbittorrent/qBittorrent/wiki/WebUI-API-(qBittorrent-4.1)

## Endpoint

`GET /api/v2/transfer/info`

Authentication is `session-exchange`: `POST /api/v2/auth/login` with a form body returns a
`SID` cookie that every later request carries. One login is shared by every widget pointed at the
same instance — qBittorrent counts concurrent sessions and starts refusing.

## Fixture

`fixtures/transfer.upstream.json` is a trimmed JSON response, with fields this widget does not read removed. Re-record with `neo catalog test --write`
after changing the projection; the recorded projection is what CI compares against.
