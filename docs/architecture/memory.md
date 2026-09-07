# Memory

neohomepage targets a box with 1 GB of RAM total — a Proxmox LXC or a NAS — where the app usually
runs _next to_ the services it polls. The memory budget is therefore a design constraint, and it is
measured rather than asserted.

## The instrument

`packages/app/scripts/memcheck.ts` boots the real server as a child process, drives HTTP load at
it, samples the child's RSS once a second, and fails when the process exceeds a budget or drifts
upward.

```sh
pnpm --filter @neohomepage/app memcheck --duration=300 --budget-mb=250 --rps=25
```

Options: `--duration` and `--warmup` (seconds), `--budget-mb`, `--drift-pct`, `--rps`,
`--concurrency`, `--sample-ms`, `--port`, and repeatable `--node-arg=` to pass flags to the server.

Peak is judged across the whole run, because a spike during warmup still has to fit in the box.
Drift is judged on the plateau only: RSS climbs for the first minute or so, and counting that ramp
would make every clean run look like a leak. (Before the warmup window existed, a perfectly flat
run reported 6.1% drift. With it, the same run reports 0.2%.)

`neo runtime` prints what the runtime believes about the memory it may use, and exits non-zero if
V8 would let its heap outgrow that limit:

```sh
pnpm --filter @neohomepage/app neo runtime
```

## F1 results — 2026-09-06

Measured on **linux/arm64, Node 24.20.0, in a 1 GiB cgroup v2 container** (Apple M-series host via
a Lima/colima VM, 2 vCPU). 240 s soak, 25 rps sustained, 60 s warmup excluded from the plateau
statistics. Docker here is a measurement instrument, not packaging — the app is not containerised
until the last phase.

| libc  | server flags               | steady p95 | peak     | drift  |
| ----- | -------------------------- | ---------- | -------- | ------ |
| glibc | none                       | 96.5 MiB   | 96.5 MiB | +0.2 % |
| musl  | none                       | 93.6 MiB   | 93.7 MiB | +0.2 % |
| glibc | `--max-old-space-size=192` | 95.1 MiB   | 95.1 MiB | −5.5 % |
| musl  | `--max-old-space-size=192` | 91.6 MiB   | 91.8 MiB | −5.6 % |

Every configuration passed, with zero failed requests out of ~6,000 per run.

### What this settles

**V8 reads the cgroup.** In a 1 GiB container V8 sized its heap ceiling at 560 MiB, not from the
host's RAM. So `--max-old-space-size` is **not** required to keep the kernel OOM killer out of the
decision on cgroup v2 — which was the open question, because on a Proxmox node an OOM kill can take
neighbouring services down with it. This still needs confirming on an unprivileged LXC, where the
cgroup is presented differently; `neo runtime` is the one-line check.

**`os.totalmem()` lies inside a container.** It reported the host's 3904.7 MiB, not the 1024 MiB
limit. Nothing in this codebase may size a cache, a pool or a queue from `os.totalmem()` — use
`describeMemoryEnvironment().effectiveLimitBytes`, which prefers the cgroup.

**musl is consistently ~3 MiB lighter than glibc**, and capping the heap saves a further ~3–4 MiB
while producing slightly _negative_ drift, because V8 collects more eagerly against a lower
ceiling. Both are small but free, so the image will be Alpine with an explicit cap.

**The floor is roughly twice what the plan assumed.** The design budget put "Node runtime + Hono"
at ~45 MiB. The measured floor — Node 24, Hono, a health route, nothing else — is **~92 MiB**.
That is the single most useful thing F1 produced, and it lands before any of the budget was spent.
The revised shape: ~92 MiB floor, leaving the scheduler, projection cache, catalog, SSE hub and the
publish render to fit in the remainder. A realistic whole-app target is **~200 MiB peak**, still far
inside the 250 MB CI gate and comfortable in a 1 GB box beside other services.

### What it does not settle

These runs are 4 minutes on an idle 2-vCPU VM, against a server that does almost nothing yet. They
establish the floor and prove the instrument; they do not predict the finished app. The numbers are
re-measured every phase that adds a subsystem, and the CI gate is the contract.
