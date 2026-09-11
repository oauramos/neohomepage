/**
 * Dev runner: Vite (HMR, port 5173) alongside the real Hono server (port 7575); Vite proxies /api
 * and /mcp so the browser talks to one origin as in production. No `concurrently`: it would be a
 * devDependency just to spawn two processes.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import { setTimeout } from 'node:timers'
import process from 'node:process'

// The server resolves the catalog against its cwd (packages/app), which has no `catalog` directory;
// without this the catalog silently loads zero manifests.
const env = {
  ...process.env,
  NEOHOMEPAGE_CATALOG_DIR:
    process.env.NEOHOMEPAGE_CATALOG_DIR ?? resolve(import.meta.dirname, '../../../catalog'),
}

const children: ChildProcess[] = []
let shuttingDown = false

function shutdown(code: number): void {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM')
  setTimeout(() => process.exit(code), 250).unref()
}

function run(name: string, args: string[]): void {
  const child = spawn(process.execPath, args, { stdio: 'inherit', env })
  child.on('exit', (code, signal) => {
    if (shuttingDown) return
    console.error(`\n[dev] ${name} exited (${signal ?? code}) — stopping the other process`)
    shutdown(typeof code === 'number' ? code : 1)
  })
  children.push(child)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

run('server', ['--watch', '--watch-preserve-output', 'src/server/main.ts'])
run('web', ['node_modules/vite/bin/vite.js'])
