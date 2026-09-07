# neohomepage wiki

> **These pages are edited in the main repository**, under
> [`wiki/`](https://github.com/oauramos/neohomepage/tree/main/wiki), and published here by
> `pnpm wiki:publish`. Edit them there so a correction goes through review and survives the next
> publish — an edit made here will be overwritten. Corrections are very welcome either way; if
> editing here is easier, do that and open an issue saying so.

This wiki is for **"something is happening and I want it to stop"**. Symptoms, the services people
actually run, and the platforms they run them on.

The [documentation site](https://oauramos.github.io/neohomepage/) is the reference: how to install
it, what every widget does, and why the thing is shaped the way it is. Two places, two jobs, no
copies of the same text in both — if a page here starts explaining architecture, it belongs there
instead.

## Start here

|                                            |                                                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| [Troubleshooting](Troubleshooting)         | A blank widget, a container that will not start, a page with no styling. Symptom first.        |
| [Service setup notes](Service-setup-notes) | Where each service hides its API key, and the one field per service that is easy to get wrong. |
| [Running on a NAS](Running-on-a-NAS)       | Synology, QNAP, Unraid. Mostly about file ownership.                                           |
| [Running on Proxmox](Running-on-Proxmox)   | LXC and VM, and why the memory numbers look wrong inside a container.                          |
| [FAQ](FAQ)                                 | Questions with short answers.                                                                  |

## The one command worth knowing

```sh
docker exec neohomepage node packages/app/src/cli/neo.ts doctor
```

`neo doctor` reads your whole install and reports what is wrong with it, with the fix in the
message: which credential is missing and which service wants it, widgets pointing at services that
no longer exist, a credential sitting somewhere it should not be, whether anything that must never
be committed has been. It exits `0` when there is nothing to say, so it works in a cron job.

Run it before opening an issue. It answers most of them, and its output is the first thing the
[bug form](https://github.com/oauramos/neohomepage/issues/new?template=bug.yml) asks for.

## Before you file anything

- `neo doctor` output.
- Your architecture (`uname -m`) and how it is running — the container as published, your own
  compose, or from source.
- If a widget is involved: `neo fetch <widget-id>`. That performs the exact request the poller
  would and prints either the projection or an error code, with no browser in the way.

Then: [report a problem](https://github.com/oauramos/neohomepage/issues/new/choose).
