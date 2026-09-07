/**
 * The restore drill.
 *
 * The claim this project makes about backup is specific: push `/data` to a repository, lose the
 * machine, clone it onto a new one with the same secret environment variables, and the dashboard
 * comes back identical with no manual step. That is a claim with a lot of moving parts —
 * gitignore seeding, sparse serialisation, the resolve compiler, credential indirection — and any
 * one of them can quietly stop being true.
 *
 * So it is executed, end to end, rather than described:
 *
 *   1. Build a dashboard through the real API, with a real credential.
 *   2. `git init` and commit `/data`. Assert that secrets/ and state/ are NOT in the commit.
 *   3. Clone into an empty directory — a new machine, with nothing carried over.
 *   4. Boot there with the credential supplied ONLY as an environment variable.
 *   5. Assert the resolved tree hashes the same, the served board is byte-identical, `git status`
 *      is clean, and doctor reports nothing.
 *
 * Usage:
 *   node scripts/restore-drill.ts
 */
import { execFile } from 'node:child_process'
import { spawn, type ChildProcess } from 'node:child_process'
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

/**
 * Hash the resolved tree with `generatedAt` removed.
 *
 * It is a timestamp stamped once per resolve, so two runs of identical config differ only there.
 * Including it would make the drill's central assertion impossible to satisfy and tempt whoever
 * hits that into weakening the comparison to something meaningless.
 */
function resolvedHash(resolved: Record<string, unknown>): string {
  const { generatedAt, ...rest } = resolved
  void generatedAt
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
    await exec('git', ['init', '-q', '--bare'], { cwd: bare })
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

    // The grep the beta definition names, over everything the repository actually carries.
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
    console.log('booting the restore')
    server = await start(restored, RESTORED_PORT, {
      // The recommended path: the key lives in the compose file or the systemd unit, and the
      // repository never sees it. `${targetId}.apiKey` -> NEOHOMEPAGE_SECRET_<ID>_APIKEY.
      [`NEOHOMEPAGE_SECRET_${String(originalResolved.targets && (originalResolved.targets as { id: string }[])[0]?.id).toUpperCase()}_APIKEY`]:
        API_KEY,
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

      /**
       * Byte-identical, with one timestamp normalised.
       *
       * The published document embeds the resolved state, which carries `generatedAt` — stamped
       * once per resolve so that two runs over identical config differ ONLY there. That is the
       * property the publish step's no-op detection depends on, so it has to be true, and it
       * makes a literal byte comparison impossible to satisfy.
       *
       * Normalising exactly that one field, and nothing else, keeps the assertion strong: the
       * markup, the baked stylesheet, the grid CSS, the asset filenames and every projection in
       * the embedded state must all match.
       */
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

      // And the visible document — everything before the embedded state — matches literally, with
      // nothing normalised at all.
      const bodyOf = (html: string) => html.slice(0, html.indexOf('<script id="__NEO_STATE__"'))
      check(
        'the rendered markup matches with nothing normalised',
        bodyOf(board) === bodyOf(originalBoard),
      )

      const { stdout: status } = await exec('git', ['status', '--porcelain'], { cwd: restored })
      // state/ is regenerated on boot and must not show up as a change, or every restore starts
      // with a dirty tree and the next `git add -A` commits a generation.
      check('the clone is still clean after booting', status.trim() === '', status.trim())

      const doctor = await exec(process.execPath, [join(ROOT, 'src/cli/neo.ts'), 'doctor'], {
        env: {
          ...process.env,
          NEOHOMEPAGE_DATA_DIR: restored,
          NEOHOMEPAGE_CATALOG_DIR: CATALOG,
          [`NEOHOMEPAGE_SECRET_${String((originalResolved.targets as { id: string }[])[0]?.id).toUpperCase()}_APIKEY`]:
            API_KEY,
        },
      }).catch((error: unknown) => ({
        stdout: String((error as { stdout?: string }).stdout ?? error),
      }))
      check('doctor reports no errors', doctor.stdout.includes('0 problems'), doctor.stdout.trim())
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
