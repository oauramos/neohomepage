#!/usr/bin/env node
import { env } from '../server/env.ts'

/**
 * The headless surface. Every capability the UI has must be reachable here first — it is what
 * makes each phase validatable with no browser, and it is the restore/backup entry point.
 */
type Command = {
  readonly name: string
  readonly summary: string
  readonly phase: string
  readonly run?: (argv: readonly string[]) => Promise<number> | number
}

const COMMANDS: readonly Command[] = [
  { name: 'serve', summary: 'Run the server in the foreground', phase: 'F0', run: runServe },
  { name: 'env', summary: 'Print the resolved data directories', phase: 'F0', run: runEnv },
  { name: 'runtime', summary: 'Print the memory limits this process can see', phase: 'F1', run: runRuntime },
  { name: 'validate', summary: 'Validate the config tree against the schema', phase: 'F4' },
  { name: 'resolve', summary: 'Compile the sparse config into resolved.json', phase: 'F4' },
  { name: 'publish', summary: 'Render a new generation and flip the pointer', phase: 'F7' },
  { name: 'backup', summary: 'Write a single restorable archive', phase: 'F4' },
  { name: 'restore', summary: 'Restore a backup archive into the data directory', phase: 'F4' },
  { name: 'fetch', summary: 'Fetch one widget upstream and print its projection', phase: 'F5' },
  { name: 'doctor', summary: 'Report problems with the install', phase: 'F12' },
  { name: 'catalog', summary: 'sync | verify | test | record | snapshot', phase: 'F11' },
  { name: 'mcp', summary: 'Serve the MCP tools over stdio', phase: 'F10' },
  { name: 'import', summary: 'Report gethomepage config coverage', phase: 'post-1.0' },
]

function usage(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length))
  const lines = COMMANDS.map(
    (c) =>
      `  ${c.name.padEnd(width)}  ${c.summary}${c.run ? '' : `  (not implemented — ${c.phase})`}`,
  )
  return `neo — neohomepage command line\n\nUsage: neo <command> [options]\n\n${lines.join('\n')}\n`
}

function runEnv(): number {
  console.log(
    [
      `data     ${env.dataDir}`,
      `config   ${env.configDir}   (committed)`,
      `assets   ${env.assetsDir}   (committed)`,
      `secrets  ${env.secretsDir}  (never committed)`,
      `state    ${env.stateDir}    (never committed, regenerable)`,
      `listen   ${env.host}:${env.port}`,
    ].join('\n'),
  )
  return 0
}

async function runRuntime(): Promise<number> {
  const { describeMemoryEnvironment, formatMemoryEnvironment } = await import('../server/runtime.ts')
  const environment = describeMemoryEnvironment()
  console.log(formatMemoryEnvironment(environment))
  // Non-zero when V8 would outgrow the cgroup: this doubles as a check in `neo doctor`.
  return environment.heapLimitExceedsMemoryLimit ? 1 : 0
}

async function runServe(): Promise<number> {
  await import('../server/main.ts')
  return 0
}

async function main(argv: readonly string[]): Promise<number> {
  const [name, ...rest] = argv
  if (!name || name === '--help' || name === '-h' || name === 'help') {
    console.log(usage())
    return 0
  }

  const command = COMMANDS.find((c) => c.name === name)
  if (!command) {
    console.error(`neo: unknown command ${JSON.stringify(name)}\n\n${usage()}`)
    return 2
  }
  if (!command.run) {
    console.error(`neo ${command.name}: not implemented yet — scheduled for ${command.phase}`)
    return 3
  }
  return await command.run(rest)
}

process.exitCode = await main(process.argv.slice(2))
