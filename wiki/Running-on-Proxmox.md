# Running on Proxmox

Two ways, and the LXC one has a footgun that is not this project's doing.

## In an unprivileged LXC

The intended target: a Debian 13 container with 1 GB of RAM and 2 vCPUs, no swap.

```sh
apt install -y docker.io docker-compose-v2
mkdir -p /opt/neohomepage && cd /opt/neohomepage
curl -O https://raw.githubusercontent.com/oauramos/neohomepage/main/compose.yaml
docker compose up -d
```

For Docker inside an unprivileged LXC you need `nesting=1` and `keyctl=1` on the container:

```sh
pct set <vmid> --features nesting=1,keyctl=1
```

Or skip Docker and run from source with a systemd unit — the app is one Node process and does not
need a container to behave.

### Why `free -h` lies to you

Inside an LXC, `free`, `htop` and Node's own `os.totalmem()` all report the **host's** memory, not
the container's limit. This matters more than it sounds: V8 sizes its heap from what it believes
the machine has, so in a 1 GB container on a 64 GB host it will happily grow past the limit and be
killed by the kernel OOM killer — which can take neighbouring processes with it, because the
kernel is choosing, not V8.

The image sets `--max-old-space-size=192` for exactly this reason. If you run from source, set it
yourself:

```
Environment=NODE_OPTIONS=--max-old-space-size=192
```

To see the truth about the container's memory:

```sh
cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.current
```

`neo runtime` prints what the process can actually see, including whether it found a cgroup limit
at all.

### /tmp is charged to your container

Debian 13 sizes the `/tmp` tmpfs from the **host's** RAM inside an LXC, and every byte written
there is charged to the container's cgroup. A few large temporary files can OOM a container that
is nowhere near its own limit.

This app does not walk into it — the atomic writer keeps its temporary file next to its target,
inside the data directory — but it is worth knowing when something else in the same container
starts dying mysteriously.

## In a VM

Nothing special. It is a normal Docker host and none of the above applies.

## Watching a Proxmox host from the dashboard

Two widgets, and they are not the same one:

- **Proxmox cluster** — how many VMs and containers are running across everything.
- **Proxmox node** — memory, root filesystem and swap for one host.

Both need an API token; see [Service setup notes](Service-setup-notes#proxmox-ve) for the two
fields people mix up and the privilege-separation setting that makes everything return empty.
