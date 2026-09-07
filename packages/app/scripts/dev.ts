/**
 * Dev runner: the Vite dev server (HMR, port 5173) alongside the real Hono server (port 7575).
 * Vite proxies /api and /mcp to Hono, so the browser talks to one origin and the dev topology
 * matches production, where Hono serves the built assets from a single process.
 *
 * Deliberately dependency-free: `concurrently` would be a devDependency to spawn two processes.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout } from 'node:timers'
import process from 'node:process'

const children: { name: string; child: ChildProcess }[] = []
let shuttingDown = false

function shutdown(code: number): void {
  if (shuttingDown) return
  shuttingDown = true
  for (const { child } of children) if (child.exitCode === null) child.kill('SIGTERM')
  setTimeout(() => process.exit(code), 250).unref()
}

function run(name: string, args: string[]): void {
  const child = spawn(process.execPath, args, { stdio: 'inherit', env: process.env })
  child.on('exit', (code, signal) => {
    if (shuttingDown) return
    console.error(`\n[dev] ${name} exited (${signal ?? code}) — stopping the other process`)
    shutdown(typeof code === 'number' ? code : 1)
  })
  children.push({ name, child })
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

run('server', ['--watch', '--watch-preserve-output', 'src/server/main.ts'])
run('web', ['node_modules/vite/bin/vite.js'])
