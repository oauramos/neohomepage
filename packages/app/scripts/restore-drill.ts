/**
 * Restore drill: builds a dashboard through the real API, commits `/data`, clones it into an empty
 * directory, boots there with the credential supplied only by environment, and asserts the result
 * is identical and the clone stays clean.
 *
 * Usage:
 *   node scripts/restore-drill.ts
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const ROOT = resolve(import.meta.dirname, '..')
const CATALOG = join(ROOT, '../../catalog')

const ORIGINAL_PORT = 7591
const RESTORED_PORT = 7592
const API_KEY = 'restore-drill-api-key'

type Server = { child: ChildProcess; base: string }

async function start(
  dataDir: string,
  port: number,
  env: Record<string, string> = {},
): Promise<Server> {
  const child = spawn(process.execPath, [join(ROOT, 'src/server/main.ts')], {
    cwd: ROOT,
    env: {
      ...process.env,
      NEOHOMEPAGE_DATA_DIR: dataDir,
      NEOHOMEPAGE_CATALOG_DIR: CATALOG,
      NEOHOMEPAGE_PORT: String(port),
      NEOHOMEPAGE_HOST: '127.0.0.1',
      NEOHOMEPAGE_PUBLISH_MODE: 'manual',
      ...env,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  })

  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      if ((await fetch(`${base}/api/state`)).ok) break
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) throw new Error(`server on ${port} did not start`)
    await delay(50)
  }
  return { child, base }
}

async function stop(server: Server): Promise<void> {
  server.child.kill('SIGTERM')
  await Promise.race([new Promise((done) => server.child.once('exit', done)), delay(5_000)])
  if (server.child.exitCode === null) server.child.kill('SIGKILL')
}

const post = async (base: string, path: string, body: unknown) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`POST ${path} -> ${response.status}: ${text}`)
  return JSON.parse(text) as Record<string, unknown>
}

/** Hash of the resolved tree without `generatedAt`, which is stamped once per resolve. */
function resolvedHash(resolved: Record<string, unknown>): string {
  const { generatedAt, ...rest } = resolved
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex')
}

const problems: string[] = []
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!ok) problems.push(label)
}

async function main(): Promise<number> {
  const original = await mkdtemp(join(tmpdir(), 'neo-drill-original-'))
  const restored = await mkdtemp(join(tmpdir(), 'neo-drill-restored-'))
  const bare = await mkdtemp(join(tmpdir(), 'neo-drill-remote-'))

  try {
    // ---- 1. build a dashboard the way a person would -------------------------------------
    console.log('building the original dashboard')
    let server = await start(original, ORIGINAL_PORT)
    let originalResolved: Record<string, unknown>
    let originalBoard: string
    try {
      const target = await post(server.base, '/api/targets', {
        label: 'Sonarr',
        widgetType: 'sonarr-queue',
        base: { scheme: 'http', host: '10.0.0.20', port: 8989 },
        values: { apiKey: API_KEY },
      })
      await post(server.base, '/api/widgets', {
        type: 'sonarr-queue',
        targetId: target.id,
        config: { maxItems: 7 },
      })
      const feed = await post(server.base, '/api/targets', {
        label: 'Bins',
        widgetType: 'ics-feed',
        base: { scheme: 'http', host: '10.0.0.9', port: 5232, basePath: '/bins.ics' },
      })
      await post(server.base, '/api/widgets', {
        type: 'unified-calendar',
        bindings: { calendars: [feed.id] },
      })
      await post(server.base, '/api/publish', {})

      const state = (await (await fetch(`${server.base}/api/state`)).json()) as {
        resolved: Record<string, unknown>
      }
      originalResolved = state.resolved
      originalBoard = await (await fetch(`${server.base}/`)).text()
    } finally {
      await stop(server)
    }

    // ---- 2. commit /data, and prove what is NOT in it ------------------------------------
    console.log('committing the data directory')
    // `-b main`: a bare repo otherwise takes `init.defaultBranch`, and on a host defaulting to
    // `master` HEAD points at a branch never pushed here, so the clone checks out nothing.
    await exec('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: bare })
    await exec('git', ['init', '-q'], { cwd: original })
    await exec('git', ['config', 'user.email', 'drill@example.invalid'], { cwd: original })
    await exec('git', ['config', 'user.name', 'Restore Drill'], { cwd: original })
    await exec('git', ['add', '-A'], { cwd: original })
    await exec('git', ['commit', '-q', '-m', 'dashboard'], { cwd: original })
    await exec('git', ['remote', 'add', 'origin', bare], { cwd: original })
    await exec('git', ['push', '-q', 'origin', 'HEAD:refs/heads/main'], { cwd: original })

    const { stdout: tracked } = await exec('git', ['ls-files'], { cwd: original })
    const files = tracked.split('\n').filter((line) => line !== '')
    check(
      'config/ is committed',
      files.some((file) => file.startsWith('config/')),
    )
    check(
      'secrets/ is NOT committed',
      !files.some((file) => file.startsWith('secrets/')),
      files.filter((file) => file.startsWith('secrets/')).join(', '),
    )
    check(
      'state/ is NOT committed',
      !files.some((file) => file.startsWith('state/')),
      `${files.filter((file) => file.startsWith('state/')).length} file(s)`,
    )

    let leaked = false
    for (const file of files) {
      const text = await readFile(join(original, file), 'utf8').catch(() => '')
      if (text.includes(API_KEY)) leaked = true
    }
    check('no credential appears in any committed file', !leaked)

    // ---- 3. clone onto a "new machine" ---------------------------------------------------
    console.log('cloning onto a fresh machine')
    await rm(restored, { recursive: true, force: true })
    await exec('git', ['clone', '-q', bare, restored])

    // ---- 4. boot with the credential supplied ONLY by environment ------------------------
    // One env var per secret the config declares; `targets[0]` may be the credential-less feed.
    const secretEnv = Object.fromEntries(
      (originalResolved.targets as { secretRefs?: Record<string, string> }[]).flatMap((target) =>
        Object.values(target.secretRefs ?? {}).map((name) => [
          `NEOHOMEPAGE_SECRET_${name.replace(/[.-]/g, '_').toUpperCase()}`,
          API_KEY,
        ]),
      ),
    )
    if (Object.keys(secretEnv).length === 0) {
      throw new Error('the fixture declared no secrets, so this drill would prove nothing')
    }

    console.log('booting the restore')
    server = await start(restored, RESTORED_PORT, {
      ...secretEnv,
    })
    try {
      const state = (await (await fetch(`${server.base}/api/state`)).json()) as {
        resolved: Record<string, unknown>
      }
      check(
        'the resolved tree is identical',
        resolvedHash(state.resolved) === resolvedHash(originalResolved),
        `${resolvedHash(state.resolved).slice(0, 12)} vs ${resolvedHash(originalResolved).slice(0, 12)}`,
      )

      // The embedded state carries `generatedAt`, stamped once per resolve; normalise only that.
      const normalise = (html: string) =>
        html.replace(/"generatedAt":"[^"]*"/g, '"generatedAt":"<stamped>"')
      const board = await (await fetch(`${server.base}/`)).text()
      const identical = normalise(board) === normalise(originalBoard)
      if (!identical && process.env.DRILL_DIFF !== undefined) {
        const a = normalise(originalBoard).split('><')
        const b = normalise(board).split('><')
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
          if (a[i] !== b[i]) {
            console.log(
              `  diff at ${i}:\n    was: ${a[i]?.slice(0, 300)}\n    now: ${b[i]?.slice(0, 300)}`,
            )
          }
        }
      }
      check('the served board is byte-identical', identical)

      const bodyOf = (html: string) => html.slice(0, html.indexOf('<script id="__NEO_STATE__"'))
      check(
        'the rendered markup matches with nothing normalised',
        bodyOf(board) === bodyOf(originalBoard),
      )

      const { stdout: status } = await exec('git', ['status', '--porcelain'], { cwd: restored })
      // state/ is regenerated on boot and must not dirty the tree.
      check('the clone is still clean after booting', status.trim() === '', status.trim())

      const doctor = await exec(process.execPath, [join(ROOT, 'src/cli/neo.ts'), 'doctor'], {
        env: {
          ...process.env,
          NEOHOMEPAGE_DATA_DIR: restored,
          NEOHOMEPAGE_CATALOG_DIR: CATALOG,
          ...secretEnv,
        },
      }).catch((error: unknown) => ({
        stdout: String((error as { stdout?: string }).stdout ?? error),
      }))

      check('doctor reports no errors', doctor.stdout.includes('0 problems'), doctor.stdout.trim())

      // doctor passes on an empty install too, so also check the widgets came back.
      const widgets = (state.resolved as { widgets?: unknown[] }).widgets ?? []
      check(
        'the restored dashboard actually has the widgets',
        widgets.length === 2,
        `${widgets.length} widget(s)`,
      )
    } finally {
      await stop(server)
    }
  } finally {
    for (const dir of [original, restored, bare]) {
      await rm(dir, { recursive: true, force: true })
    }
  }

  console.log('')
  console.log(problems.length === 0 ? 'PASS' : `FAIL: ${problems.length} problem(s)`)
  return problems.length === 0 ? 0 : 1
}

process.exitCode = await main()
