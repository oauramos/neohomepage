/**
 * The catalog toolchain: `validate` and `test`.
 *
 * `test` runs every manifest's projection against its recorded fixtures **with the network made
 * impossible**, not merely unused. A widget whose test only passes while the contributor's LAN is
 * up is a broken widget, and the difference is invisible unless you take the network away.
 */
import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import {
  auditManifest,
  deriveRequires,
  manifestSchema,
  projectionSchema,
  runProjection,
  analyse,
  type Manifest,
} from '@neohomepage/catalog-schema'

const CATALOG_DIR = resolve(process.env.NEOHOMEPAGE_CATALOG_DIR ?? '../../catalog')

/** Frozen so a fixture's expected output can never drift with the wall clock. */
const FIXTURE_NOW = '2026-09-06T12:00:00.000Z'

type Entry = { readonly slug: string; readonly dir: string; readonly manifest: Manifest }

function fail(message: string): never {
  console.error(`catalog: ${message}`)
  process.exit(1)
}

function sealNetwork(): void {
  // Anything that reaches for the network during a catalog test is a bug in the DSL or in the
  // runner, and it must be loud rather than slow.
  const forbid = (name: string) => () => {
    throw new Error(`catalog tests must not touch the network (blocked ${name})`)
  }
  Object.defineProperty(globalThis, 'fetch', { value: forbid('fetch'), configurable: true })
}

function loadEntries(): Entry[] {
  if (!existsSync(CATALOG_DIR)) fail(`no catalog directory at ${CATALOG_DIR}`)
  const entries: Entry[] = []
  for (const slug of readdirSync(CATALOG_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()) {
    const dir = join(CATALOG_DIR, slug)
    const manifestPath = join(dir, 'manifest.json')
    if (!existsSync(manifestPath)) fail(`${slug}: no manifest.json`)

    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch (error) {
      fail(`${slug}: manifest.json is not valid JSON — ${error instanceof Error ? error.message : error}`)
    }

    const parsed = manifestSchema.safeParse(raw)
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `      ${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('\n')
      fail(`${slug}: manifest does not match the schema\n${issues}`)
    }
    if (parsed.data.id !== slug) fail(`${slug}: manifest id is "${parsed.data.id}"; it must match the directory`)
    entries.push({ slug, dir, manifest: parsed.data })
  }
  return entries
}

function validate(entries: readonly Entry[]): number {
  let problems = 0
  for (const { slug, manifest } of entries) {
    const found = auditManifest(manifest)
    try {
      const analysis = analyse(manifest.projection)
      console.log(
        `  ${found.length === 0 ? 'ok  ' : 'FAIL'} ${slug}  ` +
          `${analysis.nodes} nodes, depth ${analysis.depth}, ${analysis.loopNesting} nested loop(s)`,
      )
    } catch (error) {
      console.log(`  FAIL ${slug}  ${error instanceof Error ? error.message : String(error)}`)
      problems++
      continue
    }
    for (const problem of found) {
      console.log(`       ${problem.path}: ${problem.message}`)
      problems++
    }
  }
  return problems
}

function test(entries: readonly Entry[], write: boolean): number {
  let problems = 0
  for (const { slug, dir, manifest } of entries) {
    const fixtures = join(dir, 'fixtures')
    if (!existsSync(fixtures)) {
      console.log(`  FAIL ${slug}  no fixtures/ directory — a manifest without a recorded response is untested`)
      problems++
      continue
    }
    const operations = Object.keys(manifest.operations)
    for (const operation of operations) {
      const upstreamPath = join(fixtures, `${operation}.upstream.json`)
      const expectedPath = join(fixtures, `${operation}.expected.json`)
      if (!existsSync(upstreamPath)) {
        console.log(`  FAIL ${slug}/${operation}  missing ${operation}.upstream.json`)
        problems++
        continue
      }

      const source = JSON.parse(readFileSync(upstreamPath, 'utf8'))
      const options = Object.fromEntries(
        manifest.config.filter((f) => f.default !== undefined).map((f) => [f.name, f.default ?? null]),
      )
      const result = runProjection(manifest.projection, {
        source,
        options,
        now: FIXTURE_NOW,
        targetBaseUrl: 'http://sonarr.invalid:8989',
      })
      if (!result.ok) {
        console.log(`  FAIL ${slug}/${operation}  ${result.reason}`)
        problems++
        continue
      }

      const shape = projectionSchema.safeParse(result.value)
      if (!shape.success) {
        console.log(
          `  FAIL ${slug}/${operation}  projection does not match the render contract: ` +
            shape.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        )
        problems++
        continue
      }

      const actual = `${JSON.stringify(result.value, null, 2)}\n`
      if (write) {
        writeFileSync(expectedPath, actual)
        console.log(`  wrote ${slug}/${operation}.expected.json`)
        continue
      }
      if (!existsSync(expectedPath)) {
        console.log(`  FAIL ${slug}/${operation}  missing ${operation}.expected.json (run: neo catalog test --write)`)
        problems++
        continue
      }
      const expected = readFileSync(expectedPath, 'utf8')
      if (expected !== actual) {
        console.log(`  FAIL ${slug}/${operation}  projection changed`)
        problems++
        continue
      }
      console.log(`  ok   ${slug}/${operation}`)
    }
  }
  return problems
}

function main(): number {
  const [command, ...flags] = process.argv.slice(2)
  sealNetwork()
  const entries = loadEntries()
  console.log(`catalog: ${entries.length} manifest(s) in ${CATALOG_DIR}\n`)

  let problems: number
  switch (command) {
    case 'validate':
      problems = validate(entries)
      break
    case 'test':
      problems = validate(entries) + test(entries, flags.includes('--write'))
      break
    case 'requires':
      for (const { slug, manifest } of entries) {
        console.log(`  ${slug}: ${JSON.stringify(deriveRequires(manifest))}`)
      }
      return 0
    default:
      console.error('usage: catalog <validate|test|requires> [--write]')
      return 2
  }

  console.log('')
  console.log(problems === 0 ? 'PASS' : `FAIL: ${problems} problem(s)`)
  return problems === 0 ? 0 : 1
}

process.exitCode = main()
