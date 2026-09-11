/**
 * Performance budget gate: first boot, restart and publish latency against a synthetic install of
 * 60 widgets. Restarts reuse one seeded directory; a fresh one per boot measures disk throughput.
 *
 * Usage: node scripts/budgets.ts --widgets=60 --runs=5
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { percentile, tailPercentile } from '../src/shared/stats.ts'

const ROOT = resolve(import.meta.dirname, '..')

type Options = {
  widgets: number
  runs: number
  port: number
  /** The very first boot on a machine, paying for a cold page cache. Machine-dependent. */
  firstBootMs: number
  /** Every boot after that: a restart, a crash-loop recovery, an upgrade. App-dependent. */
  restartMs: number
  publishMs: number
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    widgets: 60,
    runs: 5,
    port: 7581,
    firstBootMs: 5000,
    restartMs: 1500,
    publishMs: 400,
  }
  const known: Record<string, (value: number) => void> = {
    widgets: (v) => (options.widgets = v),
    runs: (v) => (options.runs = v),
    port: (v) => (options.port = v),
    'first-boot-ms': (v) => (options.firstBootMs = v),
    'restart-ms': (v) => (options.restartMs = v),
    'publish-ms': (v) => (options.publishMs = v),
  }

  for (const arg of argv) {
    const index = arg.indexOf('=')
    if (!arg.startsWith('--') || index === -1) {
      throw new Error(`unrecognised argument "${arg}" — expected --name=value`)
    }
    const key = arg.slice(2, index)
    const value = Number(arg.slice(index + 1))
    const apply = known[key]
    if (apply === undefined) {
      throw new Error(`unknown option "--${key}" — one of ${Object.keys(known).join(', ')}`)
    }
    if (!Number.isFinite(value))
      throw new Error(`--${key} needs a number, got "${arg.slice(index + 1)}"`)
    apply(value)
  }
  return options
}

/**
 * Writes the config tree directly so the API's transactions and debounced publishes stay out of
 * the numbers.
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
          // Port nothing listens on, so upstream fetches fail fast.
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
      // Ready means the rendered board, not an open socket.
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

async function publish(base: string, label: string): Promise<void> {
  const response = await fetch(`${base}/api/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label }),
  })
  if (!response.ok) throw new Error(`publish failed with ${response.status}`)
  await response.text()
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2))
  const base = `http://127.0.0.1:${options.port}`
  const failures: string[] = []

  console.log(`budgets: ${options.widgets} widgets, ${options.runs} runs\n`)

  // ---- boot ------------------------------------------------------------------------------
  // One seeded directory: the first boot renders a generation from empty state, every restart
  // serves the one already on disk.
  const bootDir = await mkdtemp(join(tmpdir(), 'neo-budget-boot-'))
  let firstBoot: number
  const restarts: number[] = []
  try {
    await seedFixture(bootDir, options.widgets)

    const child = startServer(bootDir, options.port)
    try {
      firstBoot = await waitForBoard(`${base}/`, 30_000)
    } finally {
      await stop(child)
    }

    for (let run = 0; run < Math.max(1, options.runs - 1); run++) {
      const again = startServer(bootDir, options.port)
      try {
        restarts.push(await waitForBoard(`${base}/`, 30_000))
      } finally {
        await stop(again)
      }
    }
  } finally {
    await rm(bootDir, { recursive: true, force: true })
  }

  // First boot is dominated by a cold page cache and varies several-fold between runners, so its
  // ceiling is wide; a restart is app work on data already on disk and is gated tightly.
  const firstOk = firstBoot <= options.firstBootMs
  console.log(
    `first boot   ${firstBoot.toFixed(0)}ms  (ceiling ${options.firstBootMs}ms, empty state, must publish)  ` +
      `${firstOk ? 'ok' : 'FAIL'}`,
  )
  if (!firstOk) {
    failures.push(`first boot ${firstBoot.toFixed(0)}ms exceeds ${options.firstBootMs}ms`)
  }

  // Median, not p95: nearest-rank p95 over fewer than 20 samples is the maximum, with no outlier
  // tolerance.
  const restartMedian = percentile(restarts, 50)
  const restartOk = restartMedian <= options.restartMs
  console.log(
    `restart      median ${restartMedian.toFixed(0)}ms  (budget ${options.restartMs}ms, generation already on disk)  ` +
      `worst ${percentile(restarts, 100).toFixed(0)}ms  ` +
      `[${restarts.map((one) => one.toFixed(0)).join(', ')}]  ${restartOk ? 'ok' : 'FAIL'}`,
  )
  if (!restartOk) {
    failures.push(`restart median ${restartMedian.toFixed(0)}ms exceeds ${options.restartMs}ms`)
  }

  // ---- publish ---------------------------------------------------------------------------
  const dataDir = await mkdtemp(join(tmpdir(), 'neo-budget-'))
  const publishes: number[] = []
  try {
    await seedFixture(dataDir, options.widgets)
    const child = startServer(dataDir, options.port)
    try {
      await waitForBoard(`${base}/`, 30_000)
      // `publishNow` keeps the newest ten generations, so from the tenth publish on each one also
      // deletes a generation; warm up past that boundary so every timed sample does the same work.
      for (let i = 0; i < 15; i++) await publish(base, `warmup-${i}`)

      for (let i = 0; i < 25; i++) {
        const started = performance.now()
        await publish(base, `budget-${i}`)
        publishes.push(performance.now() - started)
      }
    } finally {
      await stop(child)
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }

  const publishMedian = percentile(publishes, 50)
  // `tailPercentile` returns null when the sample is too small for a real p95.
  const publishTail = tailPercentile(publishes, 95)
  const publishOk = publishMedian <= options.publishMs
  console.log(
    `publish      median ${publishMedian.toFixed(0)}ms  (budget ${options.publishMs}ms)  ` +
      `p95 ${publishTail === null ? 'n/a' : publishTail.toFixed(0) + 'ms'}  ` +
      `worst ${percentile(publishes, 100).toFixed(0)}ms  ${publishOk ? 'ok' : 'FAIL'}`,
  )
  if (!publishOk) {
    failures.push(`publish median ${publishMedian.toFixed(0)}ms exceeds ${options.publishMs}ms`)
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
