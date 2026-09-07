# FAQ

## Do I ever have to edit a file?

No. That is the point of the project — adding, configuring and removing a service is a form in the
browser. The files under `config/` are readable and diffable on purpose, so your backup is
reviewable, but nothing expects you to open them.

## Can I edit them anyway?

Yes. The configuration directory is watched, so a hand edit or a `git pull` shows up within a
second and the page republishes. `neo validate` checks a tree without starting anything.

## Where do my API keys go?

Into `secrets/`, mode `0600`, which is excluded from git by a `.gitignore` the app writes on first
boot. They are never written to `config/`, and that is structural rather than careful: the server
decides what is a credential from the widget's manifest, not from what the client called it, so
there is no code path that puts one there.

Better still, keep them in your compose file as `NEOHOMEPAGE_SECRET_*` variables. Then the data
repository never sees a key at all and restoring is `git clone` plus that file.

## Does it need a password?

Reads are open, writes are not. With no username and password set, anyone who can reach the port
can edit the dashboard — reasonable on a trusted LAN, and it should be a decision rather than a
surprise. Set `NEOHOMEPAGE_USERNAME` and `NEOHOMEPAGE_PASSWORD` and the editor asks for them.

Cross-site writes are refused in every mode, including with no password, because that attack — a
page on the internet POSTing to a LAN address — does not care whether you have one.

## Can I put it on the internet?

You can, behind a reverse proxy with TLS, and you should set a password first. Forward-auth is
supported for Authelia and similar: set `NEOHOMEPAGE_AUTH_MODE=forward` and
`NEOHOMEPAGE_TRUSTED_PROXIES`. It refuses to start in forward mode without that list, because
believing an identity header from anyone who can reach the port is worse than no authentication —
it looks like authentication.

## How much memory does it need?

About 46 MB resident, idle, with a handful of widgets. The container limit in the published
compose file is 320 MB and V8's heap is capped at 192 MB inside the image. It has been soaked for
an hour on arm64 under a 1 GiB cgroup: 89,937 requests, no failures, no drift.

## Does it work on a Raspberry Pi?

`linux/arm64` is one of the two architectures built, so a Pi 4 or 5 running a 64-bit OS is fine.
32-bit is not built.

## Why is there no database?

There is nothing a database would be doing. The configuration is a few kilobytes of JSON, the
projections live in memory, and the dashboard is a rendered file on disk. Adding one would mean a
second process to run out of memory on a 1 GB box.

## What happens when a service goes down?

Its widget keeps its last good reading and grows a "stale" chip with the age. After two failures
the poll interval starts multiplying by five, up to fifteen minutes, so a dead service is not
hammered forever — the box running this dashboard is usually the box running the services it
polls, and the dashboard gets blamed for slowness it caused. Nothing goes blank, and nothing else
on the page is affected.

## Why do widgets update slowly when I have not been looking?

With nobody watching for five minutes, everything decays to a ten-minute interval, and opening the
page brings it back. It is the single largest saving in the design: a home dashboard is unobserved
about twenty-two hours a day.

## What happens when the app is down?

`GET /` is a file. If the process is not running, nothing serves it — but a crash while rendering
cannot produce a broken page, because the new generation is only pointed at after it renders
successfully.

## Can I have more than one page?

Not yet. The configuration has carried `pages[]` since the beginning so it will not be a migration,
but there is no UI for it.

## Can an AI really configure it?

Yes, over MCP — `neo mcp --stdio`, or the same tools on the HTTP port. It can search the catalog,
add services and widgets, place them, and publish. It cannot read a credential, write custom CSS
or JavaScript, or name a URL; those three are permanently absent rather than merely unimplemented.
The worst a prompt-injected agent can do is create a widget that fails to authenticate.

Every change it makes goes through the same transaction the editor uses, lands in the audit log
tagged with which token did it, and cuts a generation — so "the AI rewrote my dashboard" is a
rollback rather than a support request.

## How do I roll back?

```sh
neo generations list
neo generations rollback 41
```

The last ten are kept.

## Is my data locked in?

It is a folder of JSON with the schema documented and one version number for the whole tree. There
is no export step because there is nothing to export from.

## Why is the warning colour brown?

Because the orange failed WCAG AA at 2.3:1 against white. OKLCH is the space where "same lightness"
looks like the same lightness, and WCAG contrast is a different quantity — a palette can look
balanced and be unreadable. Every text colour is checked against every surface it can sit on, in
both themes, as part of the test suite.
