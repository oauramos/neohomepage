import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test as base, type Page } from '@playwright/test'
import type { Resolved } from '../src/shared/resolved.ts'

/**
 * One server per test file on a temporary data directory; booting costs about a second and the
 * tests are read-mostly.
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

export async function sendJson<T = unknown>(
  url: string,
  body: unknown,
  method = 'POST',
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await response.json()) as T
}

export async function readState(
  page: Page,
  baseURL: string,
): Promise<{ revision: string; resolved: Resolved }> {
  return (await (await page.request.get(`${baseURL}/api/state`)).json()) as {
    revision: string
    resolved: Resolved
  }
}

/** Replaces `page.mouse` with traps so a keyboard-only test cannot quietly gain a click. */
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
