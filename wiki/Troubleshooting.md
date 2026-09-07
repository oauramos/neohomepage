# Troubleshooting

Ordered by how often each one actually happens. Every heading is a symptom.

---

## The container starts and immediately exits

```
Error: EACCES: permission denied, mkdir '/data/config'
```

The directory you bind-mounted is not writable by the user inside the container. This is the most
common first-run failure, and the cause is usually that Docker created `./data` itself — as root —
when it found the path missing.

The published `compose.yaml` handles it: the entrypoint takes ownership once and then drops to an
unprivileged user. It needs three capabilities to do that, and if you wrote your own compose you
may have dropped them:

```yaml
cap_drop: [ALL]
cap_add: [CHOWN, SETUID, SETGID]
```

If you would rather not grant those, own the directory yourself and run as that user:

```sh
mkdir -p data && sudo chown -R 1000:1000 data
```

```yaml
user: '1000:1000'
# and no cap_add at all
```

On a NAS your user id is probably not 1000 — see [Running on a NAS](Running-on-a-NAS).

---

## A widget is blank, or shows "credential unavailable"

Run `neo doctor`. If a credential is missing it names the exact environment variable:

```
✗ missing-credential: no value for secret "t3a91f.apiKey" — needed by Sonarr (t3a91f), field "apiKey"
    → set NEOHOMEPAGE_SECRET_T3A91F_APIKEY, or enter it in the editor
```

The name is derived from the service's id, so it is different in your install than in anyone
else's. That is deliberate: two Sonarrs get two credentials rather than fighting over one.

If the credential is set and the widget is still blank, ask the server directly:

```sh
neo fetch <widget-id>
```

That prints either the projection or an error code. The codes worth knowing:

| Code                   | What it means                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `missing-credential`   | The vault has no value for a secret the manifest declares.                                |
| `http-401`, `http-403` | The service rejected the credential. Wrong key, or the wrong kind of key.                 |
| `http-404`             | The path exists in the manifest but not on your instance — often a version difference.    |
| `blocked-address`      | The hostname resolved to something the egress policy refuses. See below.                  |
| `unreachable`          | No answer. Wrong port, firewall, or the service is down.                                  |
| `bad-json`, `bad-ics`  | It answered, but not with what the manifest expects. Often an HTML login page.            |
| `projection`           | It answered correctly and the manifest could not read it. That is a bug — please file it. |

---

## `blocked-address`, and the widget points at a real machine

The egress policy refuses link-local and cloud metadata addresses — `169.254.0.0/16` above all,
because that is where a compromised widget would go looking for cloud credentials. Loopback is
refused unless the service is explicitly on `127.0.0.1` or `localhost`.

Ordinary private ranges are fine: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`. If yours is one
of those and still refused, the hostname is resolving somewhere unexpected — check with
`getent hosts <name>` on the host, not in your head.

---

## The page loads but has no styling, or the editor button is missing

You are being served a **published generation** whose assets no longer exist. This happens after
upgrading, if the new bundle has different filenames and nothing has republished since.

Open the editor and press **Regenerate**, or:

```sh
docker exec neohomepage node packages/app/src/cli/neo.ts publish
```

Generations record a fingerprint of the assets they were built against, so the badge in the editor
should already be telling you there are pending changes. If it is not, that is a bug worth filing.

---

## Widgets stopped updating, but the page still loads

Two mechanisms, and both are deliberate.

**Backoff.** After two consecutive failures the interval starts multiplying by five each time, up
to a ceiling of fifteen minutes. A widget polling every minute therefore goes to five, then to
fifteen and stays there. It shows a "stale" chip with its age the whole time. Fix the service and
press refresh on the widget — an explicit request ignores backoff entirely. Nothing needs a
restart.

**Idle decay.** With no browser watching for five minutes, everything drops to a ten-minute
interval. A home dashboard is unobserved roughly twenty-two hours a day, and polling forty
services through the night for nobody is the difference between a background process and a
nuisance. Open the page and it comes back to normal.

If _everything_ stopped while you were looking at it, check that the tab still holds its live
connection — the editor header says `live` or `reconnecting`.

---

## The editor will not save: 409

Something else changed the configuration between your page loading and your saving it. Another
tab, an AI through MCP, or a `git pull` into the data directory. Reload and try again; the config
tree is watched, so the page picks up outside changes on its own within a second.

---

## Everything is slow the first time and fine afterwards

That is a cold page cache, and it is real: the first boot on a machine reads the sources and every
dependency off disk. Measured, that is about 1.9 s on a small cloud runner and about 0.4 s once
warm; restarts are ~350 ms. If your _restarts_ are slow, that is worth reporting.

---

## `git status` in the data directory is never clean

Something under `state/` or `secrets/` is being tracked. `neo doctor` says so explicitly, and
those two directories must never be committed — `state/` turns every publish into a large commit
of duplicated HTML, and `secrets/` is worse and irreversible.

```sh
git rm -r --cached state secrets
```

If `secrets/` was ever committed, **rotate every credential in it.** Git does not forget, and a
repository gets cloned, mirrored and forked.
