/**
 * The memory harness. Boots the real server as a child process, drives HTTP load at it, samples
 * the child's RSS, and fails the run if the process exceeds a budget or drifts upward.
 *
 * This is F1's instrument and, later, the CI gate. It reports the runtime's own view of its
 * memory limits first, because on the primary deployment target (an unprivileged LXC, a
 * memory-capped container) V8 may size its heap from the host's RAM rather than the cgroup — in
 * which case the kernel OOM killer arbitrates instead of V8, and it can take neighbours with it.
 *
 * Usage:
 *   node scripts/memcheck.ts --duration=300 --budget-mb=250 --rps=20
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import process from 'node:process'
import { describeMemoryEnvironment, formatMemoryEnvironment, mib } from '../src/server/runtime.ts'
import { drift, mean, percentile } from '../src/shared/stats.ts'

type Options = {
  durationSec: number
  budgetMb: number
  driftPct: number
  rps: number
  concurrency: number
  sampleMs: number
  warmupSec: number
  port: number
  nodeArgs: string[]
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    durationSec: 300,
    budgetMb: 250,
    driftPct: 15,
    rps: 20,
    concurrency: 8,
    sampleMs: 1000,
    // RSS climbs to a plateau during warmup. Counting that ramp as "drift" would make every
    // clean run look like a leak, so the statistics window starts after it.
    warmupSec: 60,
    port: 7599,
    nodeArgs: [],
  }
  for (const arg of argv) {
    // `arg.split('=', 2)` would DISCARD everything after the second field rather than keeping it,
    // so `--node-arg=--max-old-space-size=192` would silently become `--max-old-space-size` with
    // no value and the child would refuse to start. Split on the first `=` only.
    const separator = arg.indexOf('=')
    const rawKey = separator === -1 ? arg : arg.slice(0, separator)
    const rawValue = separator === -1 ? undefined : arg.slice(separator + 1)
    const key = rawKey.replace(/^--/, '')
    if (key === 'node-arg') {
      if (rawValue === undefined || rawValue === '') throw new Error(`expected --node-arg=<flag>`)
      options.nodeArgs.push(rawValue)
      continue
    }
    if (rawValue === undefined) throw new Error(`expected --key=value, got ${arg}`)
    const value = Number(rawValue)
    if (!Number.isFinite(value)) throw new Error(`${rawKey} must be a number`)
    switch (key) {
      case 'duration':
        options.durationSec = value
        break
      case 'budget-mb':
        options.budgetMb = value
        break
      case 'drift-pct':
        options.driftPct = value
        break
      case 'rps':
        options.rps = value
        break
      case 'concurrency':
        options.concurrency = value
        break
      case 'sample-ms':
        options.sampleMs = value
        break
      case 'warmup':
        options.warmupSec = value
        break
      case 'port':
        options.port = value
        break
      default:
        throw new Error(`unknown option ${arg}`)
    }
  }
  return options
}

/** RSS of another process, in bytes. /proc where it exists, ps where it does not. */
function rssBytes(pid: number): number | null {
  if (process.platform === 'linux') {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8')
      const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)
      return match?.[1] !== undefined ? Number(match[1]) * 1024 : null
    } catch {
      return null
    }
  }
  try {
    const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    return out === '' ? null : Number(out) * 1024
  } catch {
    return null
  }
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError = 'no attempt made'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) })
      if (response.ok) {
        await response.arrayBuffer()
        return
      }
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await delay(100)
  }
  throw new Error(`server did not become healthy within ${timeoutMs}ms (last: ${lastError})`)
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2))
  const environment = describeMemoryEnvironment()

  console.log('=== runtime (harness process; cgroup and OS facts are shared with the child) ===')
  console.log(formatMemoryEnvironment(environment))
  console.log(
    `server flags  ${options.nodeArgs.length === 0 ? 'none' : options.nodeArgs.join(' ')}`,
  )
  console.log('')
  console.log('=== soak ===')
  console.log(
    `duration ${options.durationSec}s · target ${options.rps} rps · budget ${options.budgetMb} MB · ` +
      `max drift ${options.driftPct}%`,
  )

  const child: ChildProcess = spawn(process.execPath, [...options.nodeArgs, 'src/server/main.ts'], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, NEOHOMEPAGE_PORT: String(options.port), NODE_ENV: 'production' },
  })
  const pid = child.pid
  if (pid === undefined) throw new Error('failed to spawn the server')

  let childExited: number | null = null
  child.on('exit', (code) => (childExited = code ?? -1))

  const base = `http://127.0.0.1:${options.port}`
  try {
    await waitForHealth(`${base}/api/health`, 20_000)

    const samples: number[] = []
    const endAt = Date.now() + options.durationSec * 1000
    let requests = 0
    let failures = 0
    let running = true

    const sampler = (async () => {
      while (running) {
        const rss = rssBytes(pid)
        if (rss !== null) samples.push(rss)
        await delay(options.sampleMs)
      }
    })()

    // Pace each worker so the fleet approximates the target rate without a token bucket.
    const perWorkerDelay = (options.concurrency / Math.max(1, options.rps)) * 1000
    const workers = Array.from({ length: options.concurrency }, () =>
      (async () => {
        while (Date.now() < endAt) {
          const startedAt = Date.now()
          try {
            const response = await fetch(`${base}/api/health`, {
              signal: AbortSignal.timeout(5000),
            })
            await response.arrayBuffer()
            if (response.ok) requests++
            else failures++
          } catch {
            failures++
          }
          const remaining = perWorkerDelay - (Date.now() - startedAt)
          if (remaining > 0) await delay(remaining)
        }
      })(),
    )

    const progress = setInterval(() => {
      const latest = samples.at(-1)
      const left = Math.max(0, Math.round((endAt - Date.now()) / 1000))
      if (latest !== undefined)
        console.log(`  ${left}s left · rss ${mib(latest)} · ${requests} req`)
    }, 30_000)

    await Promise.all(workers)
    running = false
    clearInterval(progress)
    await sampler

    if (childExited !== null)
      throw new Error(`the server exited during the soak (code ${childExited})`)
    if (samples.length < 4) throw new Error(`only ${samples.length} RSS samples — cannot judge`)

    const warmupSamples = Math.min(
      Math.floor((options.warmupSec * 1000) / options.sampleMs),
      Math.max(0, samples.length - 4),
    )
    const steady = samples.slice(warmupSamples)

    // Peak is judged across the whole run — a warmup spike still has to fit inside the box.
    // Drift is judged on the plateau only, or the startup ramp reads as a leak on every run.
    const peak = percentile(samples, 100)
    const p95 = percentile(steady, 95)
    const first = samples[0] as number
    const last = samples.at(-1) as number
    const growth = drift(steady)
    const budgetBytes = options.budgetMb * 1024 * 1024

    console.log('')
    console.log(
      `samples    ${samples.length} over ${options.durationSec}s ` +
        `(${steady.length} after ${options.warmupSec}s warmup)`,
    )
    console.log(`requests   ${requests} ok, ${failures} failed`)
    console.log(`rss first  ${mib(first)}`)
    console.log(`rss mean   ${mib(mean(steady))} (steady state)`)
    console.log(`rss p95    ${mib(p95)} (steady state)`)
    console.log(`rss peak   ${mib(peak)}`)
    console.log(`rss last   ${mib(last)}`)
    console.log(`drift      ${growth.toFixed(1)}% (steady state, first quarter vs last quarter)`)

    const problems: string[] = []
    if (peak > budgetBytes)
      problems.push(`peak ${mib(peak)} exceeds the ${options.budgetMb} MB budget`)
    if (growth > options.driftPct)
      problems.push(`drift ${growth.toFixed(1)}% exceeds ${options.driftPct}%`)
    if (failures > 0) problems.push(`${failures} requests failed`)
    if (environment.heapLimitExceedsMemoryLimit) {
      problems.push(
        'V8 heap limit exceeds the memory this process is allowed (set --max-old-space-size)',
      )
    }

    console.log('')
    if (problems.length === 0) {
      console.log('PASS')
      return 0
    }
    for (const problem of problems) console.log(`FAIL: ${problem}`)
    return 1
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await Promise.race([new Promise((r) => child.once('exit', r)), delay(5000)])
      if (child.exitCode === null) child.kill('SIGKILL')
    }
  }
}

process.exitCode = await main().catch((error: unknown) => {
  console.error(`memcheck: ${error instanceof Error ? error.message : String(error)}`)
  return 2
})
