# SABnzbd

Download speed, time remaining and the current queue.

## Provenance

Written clean-room from the vendor's own API documentation. No code, descriptor or fixture was
taken from another dashboard project.

- SABnzbd API: https://sabnzbd.org/wiki/advanced/api

## Endpoint

`GET /api?mode=queue&output=json`

The API key travels as a query parameter because SABnzbd offers no header form. It is never
logged and never reaches the browser.

## Fixture

`fixtures/queue.upstream.json` is a JSON response, trimmed to the fields this widget reads. Re-record with `neo catalog test --write`
after changing the projection; the recorded projection is what CI compares against.
