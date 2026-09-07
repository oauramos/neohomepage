import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test as base, type Page } from '@playwright/test'

/**
 * A server per test file, on a temporary data directory.
 *
 * Per file rather than per test because booting costs about a second and the tests here are
 * read-mostly; the ones that write get their own file.
 */

const PORT = 7599
const ROOT = resolve(import.meta.dirname, '../../..')

export type Harness = {
  readonly dataDir: string
  readonly baseURL: string
}

async function waitForServer(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`server did not start at ${url}`)
    await new Promise((done) => setTimeout(done, 150))
  }
}

export async function startServer(): Promise<{ harness: Harness; stop: () => Promise<void> }> {
  const dataDir = await mkdtemp(join(tmpdir(), 'neo-e2e-'))
  const child: ChildProcess = spawn(
    process.execPath,
    [join(ROOT, 'packages/app/src/server/main.ts')],
    {
      cwd: join(ROOT, 'packages/app'),
      env: {
        ...process.env,
        NEOHOMEPAGE_DATA_DIR: dataDir,
        NEOHOMEPAGE_CATALOG_DIR: join(ROOT, 'catalog'),
        NEOHOMEPAGE_PORT: String(PORT),
        NEOHOMEPAGE_HOST: '127.0.0.1',
        // Manual, so a test's edits do not race a debounced publish it did not ask for.
        NEOHOMEPAGE_PUBLISH_MODE: 'manual',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[server] ${chunk}`))

  const baseURL = `http://127.0.0.1:${PORT}`
  await waitForServer(`${baseURL}/api/state`)

  return {
    harness: { dataDir, baseURL },
    stop: async () => {
      child.kill('SIGTERM')
      await new Promise((done) => child.once('exit', done))
      await rm(dataDir, { recursive: true, force: true })
    },
  }
}

/**
 * A page whose mouse is a trap.
 *
 * The keyboard test has to prove the whole edit session works without pointing at anything, and
 * "I did not call the mouse" is not a property you can assert by reading the test — someone adds
 * one `.click()` to get a failing test green and the guarantee is gone with no signal. Taking the
 * mouse away is the only version of this that stays true.
 */
export function forbidMouse(page: Page): void {
  const trap = (name: string) => () => {
    throw new Error(
      `this test must be driven from the keyboard only, but it called page.mouse.${name}()`,
    )
  }
  Object.defineProperty(page, 'mouse', {
    configurable: true,
    get: () => ({
      click: trap('click'),
      dblclick: trap('dblclick'),
      down: trap('down'),
      up: trap('up'),
      move: trap('move'),
      wheel: trap('wheel'),
    }),
  })
}

export const test = base
export { expect } from '@playwright/test'
