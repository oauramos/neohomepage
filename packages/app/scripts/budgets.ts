/**
 * The performance budgets, measured rather than asserted.
 *
 * Three numbers the plan commits to, each with a failure the user would actually feel:
 *
 *   cold start   how long after `docker compose up` the page answers
 *   publish p95  how long an edit takes to become the served page
 *   RSS          whether it fits on the 1 GB box it is for (the memory harness owns this one)
 *
 * Run against a synthetic install of 60 widgets, which is roughly four times a realistic home
 * dashboard — a budget met only at realistic size is a budget that fails the first enthusiast.
 *
 * Usage:
 *   node scripts/budgets.ts --widgets=60 --runs=5
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { percentile } from '../src/shared/stats.ts'

const ROOT = resolve(import.meta.dirname, '..')

type Options = {
  widgets: number
  runs: number
  port: number
  /** The very first boot on a machine, paying for a cold page cache. Machine-dependent. */
  firstBootMs: number
  /** Every boot after that: a restart, a crash-loop recovery, an upgrade. App-dependent. */
  restartMs: number
  publishP95Ms: number
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    widgets: 60,
    runs: 5,
    port: 7581,
    firstBootMs: 5000,
    restartMs: 1500,
    publishP95Ms: 400,
  }
  for (const arg of argv) {
    // Split on the FIRST `=` only: a value may legitimately contain one.
    const index = arg.indexOf('=')
    if (!arg.startsWith('--') || index === -1) continue
    const key = arg.slice(2, index)
    const value = Number(arg.slice(index + 1))
    if (Number.isNaN(value)) continue
    if (key === 'widgets') options.widgets = value
    if (key === 'runs') options.runs = value
    if (key === 'port') options.port = value
    if (key === 'first-boot-ms') options.firstBootMs = value
    if (key === 'restart-ms') options.restartMs = value
    if (key === 'publish-p95-ms') options.publishP95Ms = value
  }
  return options
}

/**
 * Write a config tree directly, rather than driving the API sixty times.
 *
 * The measurement is of boot and publish, not of the write path, and going through HTTP would put
 * sixty transactions and sixty debounced publishes into the numbers.
 */
async function seedFixture(dataDir: string, widgetCount: number): Promise<void> {
  const configDir = join(dataDir, 'config')
  for (const dir of ['targets', 'widgets', 'pages', 'layouts']) {
    await mkdir(join(configDir, dir), { recursive: true })
  }
  await mkdir(join(dataDir, 'secrets'), { recursive: true })
  await mkdir(join(dataDir, 'assets'), { recursive: true })

  await writeFile(
    join(configDir, 'dashboard.json'),
    `${JSON.stringify({ schemaVersion: 1, title: 'budget fixture' }, null, 2)}\n`,
  )
  await writeFile(
    join(configDir, 'pages', 'home.json'),
    `${JSON.stringify({ id: 'home' }, null, 2)}\n`,
  )

  const types = [
    'sonarr-queue',
    'radarr-queue',
    'uptime-kuma-status',
    'truenas-pools',
    'pihole-summary',
  ]
  const layout: { i: string; x: number; y: number; w: number; h: number }[] = []

  for (let i = 0; i < widgetCount; i++) {
    const type = types[i % types.length] as string
    const targetId = `t${String(i).padStart(3, '0')}`
    const widgetId = `w${String(i).padStart(3, '0')}`

    await writeFile(
      join(configDir, 'targets', `${targetId}.json`),
      `${JSON.stringify(
        {
          id: targetId,
          label: `Service ${i}`,
          widgetType: type,
          // A loopback port nothing listens on: the fetches fail fast and the measurement is of
          // the app rather than of somebody's LAN.
          base: { scheme: 'http', host: '127.0.0.1', port: 9 },
        },
        null,
        2,
      )}\n`,
    )
    await writeFile(
      join(configDir, 'widgets', `${widgetId}.json`),
      `${JSON.stringify({ id: widgetId, page: 'home', type, targetId }, null, 2)}\n`,
    )
    layout.push({ i: widgetId, x: (i % 3) * 4, y: Math.floor(i / 3) * 3, w: 4, h: 3 })
  }

  await writeFile(
    join(configDir, 'layouts', 'home.json'),
    `${JSON.stringify(
      { page: 'home', layouts: { lg: layout }, meta: { lg: { origin: 'authored', cols: 12 } } },
      null,
      2,
    )}\n`,
  )
}

function startServer(dataDir: string, port: number): ChildProcess {
  return spawn(process.execPath, [join(ROOT, 'src/server/main.ts')], {
    cwd: ROOT,
    env: {
      ...process.env,
      NEOHOMEPAGE_DATA_DIR: dataDir,
      NEOHOMEPAGE_CATALOG_DIR: join(ROOT, '../../catalog'),
      NEOHOMEPAGE_PORT: String(port),
      NEOHOMEPAGE_HOST: '127.0.0.1',
      NEOHOMEPAGE_PUBLISH_MODE: 'manual',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
}

async function waitForBoard(url: string, deadlineMs: number): Promise<number> {
  const started = performance.now()
  for (;;) {
    try {
      const response = await fetch(url)
      // Not merely "listening": the FIRST byte of the actual board. A server that accepts a socket
      // and then renders for a second has not started, whatever the log says.
      if (response.ok && (await response.text()).includes('neo-root')) {
        return performance.now() - started
      }
    } catch {
      // Not up yet.
    }
    if (performance.now() - started > deadlineMs) {
      throw new Error(`server did not serve a board within ${deadlineMs}ms`)
    }
    await delay(10)
  }
}

async function stop(child: ChildProcess): Promise<void> {
  child.kill('SIGTERM')
  await Promise.race([new Promise((done) => child.once('exit', done)), delay(5_000)])
  if (child.exitCode === null) child.kill('SIGKILL')
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2))
  const base = `http://127.0.0.1:${options.port}`
  const failures: string[] = []

  console.log(`budgets: ${options.widgets} widgets, ${options.runs} runs\n`)

  // ---- cold start ------------------------------------------------------------------------
  const coldStarts: number[] = []
  for (let run = 0; run < options.runs; run++) {
    const dataDir = await mkdtemp(join(tmpdir(), 'neo-budget-'))
    try {
      await seedFixture(dataDir, options.widgets)
      const child = startServer(dataDir, options.port)
      try {
        coldStarts.push(await waitForBoard(`${base}/`, 30_000))
      } finally {
        await stop(child)
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  }

  /**
   * Two numbers, because these are two different quantities and averaging them measures neither.
   *
   * The FIRST boot on a machine reads the sources and every dependency off a cold page cache. On
   * a CI runner that is ~1.9 s and on a warm laptop ~0.4 s — the difference is the disk, not the
   * app, and gating tightly on it produces a check that flakes whenever a runner is busy.
   *
   * Every boot AFTER that is compute: module resolution, type stripping, resolve, render. It came
   * out at ~350 ms on both an M-series laptop and a 2-vCPU Linux runner, which is what makes it
   * worth gating tightly — a regression there is the app's doing and nothing else's.
   *
   * The first boot still gets a ceiling, wide enough to be about a catastrophe rather than a busy
   * afternoon. It is a real cost a user pays once, and dropping it entirely would be pretending
   * the measurement is better than it is.
   */
  const [firstBoot = Number.NaN, ...restarts] = coldStarts
  const restartP95 = percentile(restarts.length > 0 ? restarts : coldStarts, 95)

  const firstOk = firstBoot <= options.firstBootMs
  console.log(
    `first boot   ${firstBoot.toFixed(0)}ms  (ceiling ${options.firstBootMs}ms, cold page cache)  ` +
      `${firstOk ? 'ok' : 'FAIL'}`,
  )
  if (!firstOk) {
    failures.push(`first boot ${firstBoot.toFixed(0)}ms exceeds ${options.firstBootMs}ms`)
  }

  const restartOk = restartP95 <= options.restartMs
  console.log(
    `restart      p95 ${restartP95.toFixed(0)}ms  (budget ${options.restartMs}ms)  ` +
      `[${restarts.map((one) => one.toFixed(0)).join(', ')}]  ${restartOk ? 'ok' : 'FAIL'}`,
  )
  if (!restartOk) {
    failures.push(`restart p95 ${restartP95.toFixed(0)}ms exceeds ${options.restartMs}ms`)
  }

  // ---- publish ---------------------------------------------------------------------------
  const dataDir = await mkdtemp(join(tmpdir(), 'neo-budget-'))
  const publishes: number[] = []
  try {
    await seedFixture(dataDir, options.widgets)
    const child = startServer(dataDir, options.port)
    try {
      await waitForBoard(`${base}/`, 30_000)
      // Twenty, and the first few are the JIT warming up — which is honest, because a user's first
      // edit after a restart pays exactly that cost.
      for (let i = 0; i < 20; i++) {
        const started = performance.now()
        const response = await fetch(`${base}/api/publish`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ label: `budget-${i}` }),
        })
        if (!response.ok) throw new Error(`publish failed with ${response.status}`)
        await response.text()
        publishes.push(performance.now() - started)
      }
    } finally {
      await stop(child)
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }

  const publishP95 = percentile(publishes, 95)
  const publishOk = publishP95 <= options.publishP95Ms
  console.log(
    `publish      p95 ${publishP95.toFixed(0)}ms  (budget ${options.publishP95Ms}ms)  ` +
      `median ${percentile(publishes, 50).toFixed(0)}ms  ${publishOk ? 'ok' : 'FAIL'}`,
  )
  if (!publishOk) {
    failures.push(`publish p95 ${publishP95.toFixed(0)}ms exceeds ${options.publishP95Ms}ms`)
  }

  console.log('')
  if (failures.length === 0) {
    console.log('PASS')
    return 0
  }
  for (const failure of failures) console.error(`FAIL ${failure}`)
  return 1
}

process.exitCode = await main()
