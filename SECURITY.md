# Security

## Reporting a vulnerability

**Please report privately**, through
[GitHub's advisory form](https://github.com/oauramos/neohomepage/security/advisories/new), not as
a public issue. You will get an acknowledgement within a few days.

Include what you would want if you were fixing it: the version or commit, how it is running
(container, from source, behind a proxy), and the smallest thing that demonstrates the problem.
A widget manifest that triggers it is ideal, because manifests are data and one can be pasted
into a report.

## What is in scope

This is software that holds API keys for services on a private network and executes a catalog
written by strangers. Those are the two things worth attacking, and both are in scope:

- **Anything that gets a credential out.** Into `config/`, into a log, into a rendered page, into
  a projection, into an MCP response, or to an upstream that should not have received it.
- **Anything that makes the server dial a URL it did not compute** from a manifest and a service
  the user configured — traversal, encoding tricks, redirects, DNS rebinding, or a request that
  reaches a link-local or metadata address.
- **Anything a malicious catalog entry can do** beyond what the user could do by typing a wrong
  hostname. Manifests carry path templates and a non-executable projection language on purpose;
  a manifest that escapes either is a vulnerability.
- **Anything that lets an unauthenticated request write.** Reads are open by design; writes are
  not, and the cross-site defences stay on even when no password is configured.
- **Path traversal in a restored archive**, or anything that writes outside `config/` and
  `assets/`.

## What is not

- **An open dashboard on a trusted LAN.** With no `NEOHOMEPAGE_USERNAME` and
  `NEOHOMEPAGE_PASSWORD` set, anyone who can reach the port can edit it. That is documented and
  deliberate; the fix is to set them.
- **Reaching a private-range address.** Polling `10.0.0.0/8`, `172.16.0.0/12` and
  `192.168.0.0/16` is the entire purpose. Link-local and cloud metadata ranges are refused, and a
  report that one of those is reachable IS in scope.
- **Denial of service by configuration** — pointing a widget at a slow endpoint and polling it.
- Findings from an automated scanner with no demonstrated impact.

## Supported versions

Pre-1.0: only `main` and the most recent release are supported. There is no backporting yet.

## What the project does about this class of bug

Three properties are structural rather than remembered, and each has a test that tries to break
it:

- The browser and the MCP server never name a URL, a path, a header or an HTTP method. The server
  computes the request from a manifest and then asserts the URL it is about to dial has exactly
  the origin and pathname it computed.
- A value for a field the manifest declares `secret` has no code path into `config/`. Routing is
  decided server-side from the manifest, not from which key the client used.
- Only projections are cached and returned. The raw upstream response is discarded before it
  reaches a cache, so an SSRF returns the handful of fields a manifest declared and nothing else.

If you find a way around one of them, that is exactly the report worth sending.
