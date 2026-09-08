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
  {
    name: 'publish',
    summary: 'Render a new generation and flip the pointer',
    phase: 'F7',
    run: runPublish,
  },
  { name: 'generations', summary: 'list | rollback <n>', phase: 'F7', run: runGenerations },
  { name: 'backup', summary: 'Write a single restorable archive', phase: 'F4', run: runBackup },
  {
    name: 'restore',
    summary: 'Restore a backup archive into the data directory',
    phase: 'F4',
    run: runRestore,
  },
  {
    name: 'fetch',
    summary: 'Fetch one widget upstream and print its projection',
    phase: 'F5',
    run: runFetch,
  },
  {
    name: 'doctor',
    summary: 'Report problems with the install',
    phase: 'F12',
    run: runDoctorCommand,
  },
  {
    name: 'catalog',
    summary: 'validate | test [--write] | requires [--write]',
    phase: 'F11',
    run: runCatalog,
  },
  { name: 'mcp', summary: 'Serve the MCP tools over stdio', phase: 'F10', run: runMcp },
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

async function runPublish(argv: readonly string[]): Promise<number> {
  const { createContext } = await import('../server/context.ts')
  const { resolve: resolvePath } = await import('node:path')
  const context = await createContext({
    catalogDir: process.env.NEOHOMEPAGE_CATALOG_DIR ?? resolvePath('catalog'),
    ...(process.env.NEOHOMEPAGE_WEB_DIST === undefined
      ? {}
      : { webDistDir: process.env.NEOHOMEPAGE_WEB_DIST }),
  })
  await context.reload()
  const label = argv.find((a) => a.startsWith('--label='))?.slice('--label='.length)
  const result = await context.publishNow('cli', label)
  console.log(`published generation ${result.generation}`)
  console.log(`  ${result.bytes} bytes in ${result.durationMs}ms`)
  await context.shutdown()
  return 0
}

async function runGenerations(argv: readonly string[]): Promise<number> {
  const { Generations } = await import('../server/store/generations.ts')
  const generations = new Generations(env.stateDir)
  const [sub, argument] = argv.filter((a) => !a.startsWith('-'))

  if (sub === undefined || sub === 'list') {
    const all = await generations.list()
    const current = await generations.current()
    if (all.length === 0) {
      console.log('no generations yet')
      return 0
    }
    for (const n of all) {
      const meta = await generations.meta(n)
      const marker = n === current ? '*' : ' '
      console.log(
        `${marker} ${String(n).padStart(6, '0')}  ${meta?.createdAt ?? '?'}  ` +
          `${meta?.actor ?? '?'}${meta?.label ? `  ${meta.label}` : ''}`,
      )
    }
    return 0
  }

  if (sub === 'rollback') {
    const n = Number(argument)
    if (!Number.isInteger(n)) {
      console.error('usage: neo generations rollback <n>')
      return 2
    }
    await generations.rollback(n)
    console.log(`now serving generation ${n}`)
    return 0
  }

  console.error('usage: neo generations [list | rollback <n>]')
  return 2
}

async function runFetch(argv: readonly string[]): Promise<number> {
  const widgetId = argv.find((a) => !a.startsWith('-'))
  if (widgetId === undefined) {
    console.error('usage: neo fetch <widget-id> [--operation=<name>]')
    return 2
  }

  const { ConfigStore } = await import('../server/store/configstore.ts')
  const { loadCatalogDirectory } = await import('../server/catalog/load.ts')
  const { probe } = await import('../server/fetcher/probe.ts')
  const { isComposite } = await import('@neohomepage/catalog-schema')
  const { loadSecrets } = await import('../server/secrets/vault.ts')
  const { resolve: resolvePath } = await import('node:path')

  const store = new ConfigStore(env.configDir)
  const { tree } = await store.load()
  const widget = tree.widgets.get(widgetId)
  if (widget === undefined) {
    console.error(
      `no widget "${widgetId}" (have: ${[...tree.widgets.keys()].join(', ') || 'none'})`,
    )
    return 2
  }

  const catalogDir = process.env.NEOHOMEPAGE_CATALOG_DIR ?? resolvePath('catalog')
  const { manifests } = await loadCatalogDirectory(catalogDir)
  const manifest = manifests.get(widget.type)
  if (manifest === undefined) {
    console.error(`widget type "${widget.type}" is not in the catalog at ${catalogDir}`)
    return 2
  }

  const vault = await loadSecrets(env.secretsDir)
  const requested = argv.find((a) => a.startsWith('--operation='))?.split('=')[1]

  /**
   * Every (target, probe) pair this widget would fetch.
   *
   * A composite has one per bound target rather than one per operation, and `neo fetch` prints a
   * line for each. That is the point of the command against real hardware: a calendar that says
   * "✓" while three of its five sources are silently unbound has told you nothing.
   */
  const probes: {
    label: string
    target: NonNullable<ReturnType<typeof tree.targets.get>>
    kind?: string
    operation?: string
  }[] = []

  if (isComposite(manifest)) {
    for (const [roleName, role] of Object.entries(manifest.roles)) {
      for (const targetId of widget.bindings[roleName] ?? []) {
        const bound = tree.targets.get(targetId)
        if (bound === undefined) {
          console.error(`✗ ${widgetId}/${roleName}  missing target "${targetId}"`)
          continue
        }
        if (role.kinds[bound.widgetType] === undefined) {
          console.error(
            `✗ ${widgetId}/${roleName}  target "${targetId}" is a ${bound.widgetType}, ` +
              `which role "${roleName}" does not accept`,
          )
          continue
        }
        probes.push({
          label: `${roleName}:${bound.widgetType}:${bound.id}`,
          target: bound,
          kind: bound.widgetType,
        })
      }
    }
    if (probes.length === 0) {
      console.error(`widget "${widgetId}" has no usable bindings`)
      return 2
    }
  } else {
    const target = widget.targetId === null ? undefined : tree.targets.get(widget.targetId)
    if (target === undefined) {
      console.error(`widget "${widgetId}" has no bound target`)
      return 2
    }
    for (const operation of requested !== undefined
      ? [requested]
      : Object.keys(manifest.operations)) {
      probes.push({ label: operation, target, operation })
    }
  }

  let failures = 0
  for (const entry of probes) {
    const secrets: Record<string, string> = {}
    for (const [field, ref] of Object.entries(entry.target.secrets)) {
      const value = vault.get(ref.$secret)
      if (value !== undefined) secrets[field] = value
    }

    const startedAt = performance.now()
    const result = await probe({
      manifest,
      ...(entry.kind === undefined ? {} : { kind: entry.kind }),
      ...(entry.operation === undefined ? {} : { operation: entry.operation }),
      target: {
        origin: `${entry.target.base.scheme}://${entry.target.base.host}:${entry.target.base.port}`,
        basePath: entry.target.base.basePath,
        allowLoopback:
          entry.target.base.host === '127.0.0.1' || entry.target.base.host === 'localhost',
        insecureSkipVerify: entry.target.tls.insecureSkipVerify,
      },
      config: widget.config,
      auth: { secrets, config: entry.target.fields },
      now: new Date().toISOString(),
    })
    const ms = Math.round(performance.now() - startedAt)

    if (result.ok) {
      console.log(`✓ ${widgetId}/${entry.label}  ${manifest.presentation.template}  ${ms}ms`)
      console.log(JSON.stringify(result.projection, null, 2))
    } else {
      console.error(`✗ ${widgetId}/${entry.label}  ${result.code}: ${result.message}  ${ms}ms`)
      failures++
    }
  }
  return failures === 0 ? 0 : 1
}

/**
 * `neo doctor`.
 *
 * Exit code is the contract: 0 means nothing is wrong, 1 means something needs attention. That is
 * what lets it go in a cron job or a health check, and it is the clause in the beta definition
 * that has to print `0 problems`.
 *
 * Warnings alone do not fail. A spare target and a large wallpaper are worth saying and not worth
 * paging anyone about; conflating them with a missing credential would train people to ignore
 * the exit code.
 */
async function runDoctorCommand(argv: readonly string[]): Promise<number> {
  const { ConfigStore } = await import('../server/store/configstore.ts')
  const { loadCatalogDirectory } = await import('../server/catalog/load.ts')
  const { loadSecrets } = await import('../server/secrets/vault.ts')
  const { resolve: resolveTree } = await import('../server/resolve/resolve.ts')
  const { runDoctor, unknownKeys } = await import('../server/doctor.ts')
  const { storedSecretNames } = await import('../server/secrets/vault.ts')
  const { resolve: resolvePath } = await import('node:path')

  const quiet = argv.includes('--quiet')
  const asJson = argv.includes('--json')

  const store = new ConfigStore(env.configDir)
  const { tree } = await store.load()
  const { manifests } = await loadCatalogDirectory(
    process.env.NEOHOMEPAGE_CATALOG_DIR ?? resolvePath('catalog'),
  )
  const vault = await loadSecrets(env.secretsDir)
  const resolved = resolveTree({
    tree,
    catalog: manifests,
    generatedAt: new Date().toISOString(),
  })

  const findings = [
    ...(await runDoctor({
      env,
      tree,
      catalog: manifests,
      hasSecret: (name) => vault.has(name),
      storedNames: new Set(await storedSecretNames(env.secretsDir)),
      diagnostics: resolved.diagnostics,
    })),
    ...(await unknownKeys(env.configDir)),
  ]

  const errors = findings.filter((one) => one.severity === 'error').length
  const warnings = findings.filter((one) => one.severity === 'warning').length

  if (asJson) {
    console.log(JSON.stringify({ findings, errors, warnings }, null, 2))
    return errors === 0 ? 0 : 1
  }

  const mark = { error: '✗', warning: '!', note: '·' } as const
  for (const finding of findings) {
    if (quiet && finding.severity !== 'error') continue
    console.log(`${mark[finding.severity]} ${finding.code}: ${finding.message}`)
    if (finding.fix !== undefined) console.log(`    → ${finding.fix}`)
  }

  if (findings.length > 0) console.log('')
  console.log(
    errors === 0 && warnings === 0
      ? '0 problems'
      : `${errors} error(s), ${warnings} warning(s), ${findings.length - errors - warnings} note(s)`,
  )
  return errors === 0 ? 0 : 1
}

async function runMcp(argv: readonly string[]): Promise<number> {
  const { createContext } = await import('../server/context.ts')
  const { buildDashboardServer, TOOL_NAMES } = await import('../server/mcp/server.ts')
  const { resolve: resolvePath } = await import('node:path')

  // `NEOHOMEPAGE_PUBLISH_MODE` is read here as well as in `main.ts`, and it has to be: this is a
  // SECOND process holding its own store and its own publish mutex, so an install that turned
  // auto-publish off to keep one process in charge of the generation directory was still getting
  // a render — and a generation number — from whichever of the two got there first.
  const context = await createContext({
    catalogDir: process.env.NEOHOMEPAGE_CATALOG_DIR ?? resolvePath('catalog'),
    ...(process.env.NEOHOMEPAGE_PUBLISH_MODE === 'manual'
      ? { publishMode: 'manual' as const }
      : {}),
  })
  await context.reload()
  if (argv.includes('--print-tools')) {
    console.log(JSON.stringify({ tools: TOOL_NAMES }, null, 2))
    await context.shutdown()
    return 0
  }

  const { serveStdio } = await import('@modelcontextprotocol/server/stdio')
  // A FACTORY, not an instance: the SDK builds a server per connection, and passing the instance
  // typechecks as an error rather than failing at runtime, which is the good outcome.
  await serveStdio(() => buildDashboardServer({ context, actor: 'mcp:stdio' }))
  return 0
}

/**
 * Refuse a flag this command does not implement.
 *
 * `neo backup --include-secrets` used to be documented, was never implemented, and was silently
 * discarded — so it wrote a perfectly ordinary archive, printed success, and left someone
 * believing their credentials were backed up. A command that accepts an option it does not honour
 * is worse than one that has no options.
 */
class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

function rejectUnknownFlags(argv: readonly string[], known: readonly string[]): void {
  for (const arg of argv) {
    if (!arg.startsWith('-')) continue
    const name = arg.split('=', 1)[0] as string
    if (known.includes(name)) continue
    throw new UsageError(
      `unknown option "${name}"` +
        (known.length > 0 ? ` — this command accepts ${known.join(', ')}` : ' — it takes none'),
    )
  }
}

async function runBackup(argv: readonly string[]): Promise<number> {
  rejectUnknownFlags(argv, [])
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

/**
 * `neo catalog` — the same script `pnpm catalog:*` runs.
 *
 * It was listed in the help as `sync | verify | test | record | snapshot` and had no
 * implementation at all, so three of those five subcommands do not exist and `neo catalog test`
 * printed "not implemented yet" while `pnpm catalog:test` worked. Advertising a command surface
 * that does not match the one that exists is worse than advertising nothing.
 */
async function runCatalog(argv: readonly string[]): Promise<number> {
  const { resolve: resolvePath } = await import('node:path')
  const { spawnSync } = await import('node:child_process')

  const script = resolvePath(import.meta.dirname, '../../scripts/catalog.ts')
  const result = spawnSync(process.execPath, [script, ...argv], {
    stdio: 'inherit',
    env: process.env,
  })
  return result.status ?? 1
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

  try {
    return await command.run(rest)
  } catch (error) {
    // A usage mistake is a message, not a stack trace. The trace is still available when
    // something genuinely unexpected happens — it is only the argument errors that are quiet,
    // because those are the ones where the reader is the person who mistyped.
    if (error instanceof UsageError) {
      console.error(`neo ${command.name}: ${error.message}`)
      return 2
    }
    throw error
  }
}

process.exitCode = await main(process.argv.slice(2))
