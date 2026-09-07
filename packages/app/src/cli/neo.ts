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
  { name: 'init', summary: 'Create and seed the data directory', phase: 'F4', run: runInit },
  {
    name: 'runtime',
    summary: 'Print the memory limits this process can see',
    phase: 'F1',
    run: runRuntime,
  },
  {
    name: 'validate',
    summary: 'Validate the config tree against the schema',
    phase: 'F4',
    run: runValidate,
  },
  {
    name: 'resolve',
    summary: 'Compile the sparse config into resolved.json',
    phase: 'F4',
    run: runResolve,
  },
  { name: 'publish', summary: 'Render a new generation and flip the pointer', phase: 'F7' },
  { name: 'backup', summary: 'Write a single restorable archive', phase: 'F4', run: runBackup },
  {
    name: 'restore',
    summary: 'Restore a backup archive into the data directory',
    phase: 'F4',
    run: runRestore,
  },
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
  const { describeMemoryEnvironment, formatMemoryEnvironment } =
    await import('../server/runtime.ts')
  const environment = describeMemoryEnvironment()
  console.log(formatMemoryEnvironment(environment))
  // Non-zero when V8 would outgrow the cgroup: this doubles as a check in `neo doctor`.
  return environment.heapLimitExceedsMemoryLimit ? 1 : 0
}

async function seedPaths() {
  return {
    dataDir: env.dataDir,
    configDir: env.configDir,
    assetsDir: env.assetsDir,
    secretsDir: env.secretsDir,
    stateDir: env.stateDir,
  }
}

async function runInit(): Promise<number> {
  const { seedDataDirectory } = await import('../server/store/seed.ts')
  const { seedStarterConfig } = await import('../server/store/starter.ts')
  const written = await seedDataDirectory(await seedPaths())
  const starter = await seedStarterConfig(env.configDir)
  console.log(`data directory ready at ${env.dataDir}`)
  for (const path of [...written, ...starter]) console.log(`  created ${path}`)
  if (written.length === 0 && starter.length === 0)
    console.log('  (already seeded, nothing to write)')
  console.log('\nMake it a backup by running, in that directory:  git init && git add -A')
  return 0
}

async function runValidate(): Promise<number> {
  const { ConfigStore } = await import('../server/store/configstore.ts')
  const { validateTree } = await import('../server/store/tree.ts')
  const store = new ConfigStore(env.configDir)

  let loaded
  try {
    loaded = await store.load()
  } catch (error) {
    console.error(`invalid: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }

  for (const warning of loaded.warnings) console.log(`warning  ${warning.path}: ${warning.message}`)
  const problems = validateTree(loaded.tree)
  for (const problem of problems) console.error(`problem  ${problem.path}: ${problem.message}`)

  const counts =
    `${loaded.tree.pages.size} page(s), ${loaded.tree.widgets.size} widget(s), ` +
    `${loaded.tree.targets.size} target(s)`
  console.log(`\nrevision ${loaded.revision} — ${counts}`)
  console.log(problems.length === 0 ? 'OK' : `${problems.length} problem(s)`)
  return problems.length === 0 ? 0 : 1
}

async function runResolve(argv: readonly string[]): Promise<number> {
  const { ConfigStore } = await import('../server/store/configstore.ts')
  const { loadCatalogDirectory } = await import('../server/catalog/load.ts')
  const { resolve: resolveTree } = await import('../server/resolve/resolve.ts')
  const { overridesSchema, EMPTY_OVERRIDES } = await import('../server/config/overrides.ts')
  const { readFile } = await import('node:fs/promises')
  const { resolve: resolvePath } = await import('node:path')

  const store = new ConfigStore(env.configDir)
  const { tree } = await store.load()

  const catalogDir = process.env.NEOHOMEPAGE_CATALOG_DIR ?? resolvePath('catalog')
  const catalog = await loadCatalogDirectory(catalogDir)
  for (const entry of catalog.rejected)
    console.error(`catalog: skipped ${entry.slug} — ${entry.reason}`)

  let overrides = EMPTY_OVERRIDES
  try {
    overrides = overridesSchema.parse(JSON.parse(await readFile(store.paths.overrides, 'utf8')))
  } catch {
    // No local overrides is the normal case, not an error.
  }

  const resolved = resolveTree({
    tree,
    catalog: catalog.manifests,
    overrides,
    generatedAt: new Date().toISOString(),
  })

  const out = argv.find((a) => !a.startsWith('-'))
  const text = `${JSON.stringify(resolved, null, 2)}\n`
  if (out === undefined || out === '-') {
    process.stdout.write(text)
  } else {
    const { writeFileDurable } = await import('../server/store/atomic.ts')
    await writeFileDurable(out, text)
    console.log(`wrote ${out}`)
  }
  for (const note of resolved.diagnostics) console.error(`diagnostic: ${note}`)
  return 0
}

async function runBackup(argv: readonly string[]): Promise<number> {
  const { backup, defaultArchiveName } = await import('../server/store/backup.ts')
  const explicit = argv.find((a) => !a.startsWith('-'))
  const archive = explicit ?? defaultArchiveName(new Date())
  const result = await backup({ dataDir: env.dataDir, archive })
  console.log(`wrote ${result.archive}`)
  console.log(`  included: ${result.included.join(', ')}`)
  console.log('  secrets/ and state/ are never included — see docs/guide/backup.md')
  return 0
}

async function runRestore(argv: readonly string[]): Promise<number> {
  const archive = argv.find((a) => !a.startsWith('-'))
  if (archive === undefined) {
    console.error('usage: neo restore <archive.tar.gz>')
    return 2
  }
  const { restore } = await import('../server/store/backup.ts')
  const result = await restore({ archive, dataDir: env.dataDir })
  console.log(`restored ${result.entries.length} entries into ${result.dataDir}`)
  console.log('Provide your API keys (environment variables or secrets/), then start the server.')
  return 0
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
