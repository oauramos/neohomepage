# Proxmox node

Memory, root filesystem and swap for one Proxmox host.

## Provenance

Written clean-room from the vendor's own API documentation. No code, descriptor or fixture was
taken from another dashboard project.

- Proxmox VE API: https://pve.proxmox.com/pve-docs/api-viewer/

## Endpoint

`GET /api2/json/nodes/{node}/status`

The `PVEAPIToken=id=secret` form is expressed with the ordinary `header` auth kind — the token id
is a plain config field and only the secret half comes from the vault.

## Fixture

`fixtures/status.upstream.json` is a JSON response, trimmed to the fields this widget reads. Re-record with `neo catalog test --write`
after changing the projection; the recorded projection is what CI compares against.
