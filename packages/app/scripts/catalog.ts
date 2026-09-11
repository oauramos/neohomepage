/**
 * Catalog toolchain: `validate`, `test` and `requires`. `test` runs every manifest's projection
 * against its recorded fixtures with the network blocked.
 */
import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import {
  analyse,
  auditManifest,
  AUTH_KINDS,
  DECODERS,
  deriveRequires,
  isComposite,
  parseManifest,
  projectionSchema,
  runProjection,
  sourceKinds,
  TEMPLATES,
  type Decoder,
  type Field,
  type Json,
  type Manifest,
  type Node,
} from '@neohomepage/catalog-schema'
import { decode } from '../src/server/decode/index.ts'

const CATALOG_DIR =
  process.env.NEOHOMEPAGE_CATALOG_DIR ?? resolve(import.meta.dirname, '../../../catalog')

/** Frozen so a fixture's expected output can never drift with the wall clock. */
const FIXTURE_NOW = '2026-09-06T12:00:00.000Z'

type Entry = { readonly slug: string; readonly dir: string; readonly manifest: Manifest }

/** A stand-in value for a required option, chosen so the projection sees the right type. */
function sampleFor(field: Field): Json {
  switch (field.kind) {
    case 'integer':
    case 'number':
    case 'duration':
      return 1
    case 'boolean':
      return false
    case 'enum':
      return field.options?.[0]?.value ?? 'sample'
    case 'url':
      return 'https://example.invalid/'
    case 'color':
      return '#336699'
    default:
      return `sample-${field.name}`
  }
}

function fail(message: string): never {
  console.error(`catalog: ${message}`)
  process.exit(1)
}

function sealNetwork(): void {
  // Throws rather than hangs so a manifest that needs the network fails loudly.
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
      fail(
        `${slug}: manifest.json is not valid JSON — ${error instanceof Error ? error.message : error}`,
      )
    }

    const parsed = parseManifest(raw)
    if (!parsed.ok) {
      const issues = parsed.issues.map((i) => `      ${i.path}: ${i.message}`).join('\n')
      fail(`${slug}: does not match the ${parsed.shape}-source manifest schema\n${issues}`)
    }
    if (parsed.manifest.id !== slug)
      fail(`${slug}: manifest id is "${parsed.manifest.id}"; it must match the directory`)
    entries.push({ slug, dir, manifest: parsed.manifest })
  }
  return entries
}

/**
 * One recorded upstream response and the projections run against it: one per operation for a
 * single-target widget, one per source kind for a composite, whose emits all read the same decode.
 */
type Probe = {
  readonly name: string
  readonly decode: Decoder
  readonly projections: readonly { readonly label: string; readonly node: Node }[]
  /** Composite emits produce item arrays that are concatenated; single projections stand alone. */
  readonly concatItems: boolean
}

function probesOf(manifest: Manifest): Probe[] {
  if (isComposite(manifest)) {
    return sourceKinds(manifest).map(({ kind, source }) => ({
      name: kind,
      decode: source.operation.decode ?? 'json',
      projections: source.emits.map((emit) => ({ label: emit.id, node: emit.projection })),
      concatItems: true,
    }))
  }
  return Object.entries(manifest.operations).map(([name, operation]) => ({
    name,
    decode: operation.decode ?? 'json',
    projections: [{ label: name, node: manifest.projection }],
    concatItems: false,
  }))
}

/** The fixture extension a decoder reads, so an ICS fixture is a real .ics file on disk. */
const FIXTURE_EXTENSION: Record<Decoder, string> = { json: 'json', ics: 'ics', text: 'txt' }

function validate(entries: readonly Entry[]): number {
  let problems = 0
  for (const { slug, dir, manifest } of entries) {
    const found = auditManifest(manifest)

    // Clean-room provenance is a review gate; a widget without a README cannot be reviewed for it.
    if (!existsSync(join(dir, 'README.md'))) {
      console.log(
        `  FAIL ${slug}  no README.md — every widget states which vendor documentation it was written from`,
      )
      problems++
    }
    let described = false
    try {
      const totals = probesOf(manifest)
        .flatMap((probe) => probe.projections)
        .map((projection) => analyse(projection.node))
      const nodes = totals.reduce((sum, one) => sum + one.nodes, 0)
      const depth = Math.max(0, ...totals.map((one) => one.depth))
      const loops = Math.max(0, ...totals.map((one) => one.loopNesting))
      console.log(
        `  ${found.length === 0 ? 'ok  ' : 'FAIL'} ${slug}  ` +
          `${totals.length} projection(s), ${nodes} nodes, depth ${depth}, ${loops} nested loop(s)`,
      )
      described = true
    } catch (error) {
      console.log(`  FAIL ${slug}  ${error instanceof Error ? error.message : String(error)}`)
      problems++
    }
    if (!described) continue
    for (const problem of found) {
      console.log(`       ${problem.path}: ${problem.message}`)
      problems++
    }
  }
  return problems
}

/** Templates, auth kinds and decoders the catalog exercises, against all the app supports. */
function coverage(entries: readonly Entry[]): number {
  const seen = {
    templates: new Set<string>(),
    authKinds: new Set<string>(),
    fetchKinds: new Set<string>(),
  }
  for (const { manifest } of entries) {
    const derived = deriveRequires(manifest)
    for (const template of derived.templates) seen.templates.add(template)
    for (const kind of derived.authKinds) seen.authKinds.add(kind)
    for (const kind of derived.fetchKinds) seen.fetchKinds.add(kind)
  }

  const line = (label: string, have: Set<string>, all: readonly string[]) => {
    const missing = all.filter((name) => !have.has(name))
    return (
      `${label} ${have.size}/${all.length}` +
      (missing.length === 0 ? '' : ` (missing ${missing.join(', ')})`)
    )
  }

  console.log(
    `coverage: ${line('templates', seen.templates, TEMPLATES)} · ` +
      `${line('auth kinds', seen.authKinds, AUTH_KINDS)} · ` +
      `${line('decoders', seen.fetchKinds, DECODERS)}`,
  )

  // Counted so an uncovered capability fails the run instead of only printing a footer.
  return (
    TEMPLATES.filter((t) => !seen.templates.has(t)).length +
    AUTH_KINDS.filter((k) => !seen.authKinds.has(k)).length +
    DECODERS.filter((d) => !seen.fetchKinds.has(d)).length
  )
}

function test(entries: readonly Entry[], write: boolean): number {
  let problems = 0
  for (const { slug, dir, manifest } of entries) {
    const fixtures = join(dir, 'fixtures')
    if (!existsSync(fixtures)) {
      console.log(
        `  FAIL ${slug}  no fixtures/ directory — a manifest without a recorded response is untested`,
      )
      problems++
      continue
    }

    // Required options without a default get a sample value, or the projection would run with null.
    const options: Record<string, Json> = Object.fromEntries(
      manifest.config.map((field) => [field.name, field.default ?? sampleFor(field)] as const),
    )

    for (const probe of probesOf(manifest)) {
      const extension = FIXTURE_EXTENSION[probe.decode]
      const upstreamPath = join(fixtures, `${probe.name}.upstream.${extension}`)
      const expectedPath = join(fixtures, `${probe.name}.expected.json`)
      if (!existsSync(upstreamPath)) {
        console.log(`  FAIL ${slug}/${probe.name}  missing ${probe.name}.upstream.${extension}`)
        problems++
        continue
      }

      // Through the real decoder, so an .ics fixture exercises the ICS path offline.
      let source: Json
      try {
        source = decode(probe.decode, readFileSync(upstreamPath, 'utf8'), { now: FIXTURE_NOW })
      } catch (error) {
        console.log(
          `  FAIL ${slug}/${probe.name}  decode failed: ` +
            (error instanceof Error ? error.message : String(error)),
        )
        problems++
        continue
      }

      const items: Json[] = []
      let value: Json = null
      let failed = false

      for (const projection of probe.projections) {
        const result = runProjection(projection.node, {
          source,
          options,
          now: FIXTURE_NOW,
          targetBaseUrl: 'http://service.invalid:8989',
        })
        if (!result.ok) {
          console.log(`  FAIL ${slug}/${probe.name}#${projection.label}  ${result.reason}`)
          problems++
          failed = true
          break
        }
        if (!probe.concatItems) {
          value = result.value
          continue
        }
        if (!Array.isArray(result.value)) {
          console.log(
            `  FAIL ${slug}/${probe.name}#${projection.label}  an emit must project an array ` +
              `of items, got ${result.value === null ? 'null' : typeof result.value}`,
          )
          problems++
          failed = true
          break
        }
        items.push(...result.value)
      }
      if (failed) continue
      if (probe.concatItems) value = { items }

      const shape = projectionSchema.safeParse(value)
      if (!shape.success) {
        console.log(
          `  FAIL ${slug}/${probe.name}  projection does not match the render contract: ` +
            shape.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        )
        problems++
        continue
      }

      const actual = `${JSON.stringify(value, null, 2)}\n`
      if (write) {
        writeFileSync(expectedPath, actual)
        console.log(`  wrote ${slug}/${probe.name}.expected.json`)
        continue
      }
      if (!existsSync(expectedPath)) {
        console.log(
          `  FAIL ${slug}/${probe.name}  missing ${probe.name}.expected.json (run: neo catalog test --write)`,
        )
        problems++
        continue
      }
      if (readFileSync(expectedPath, 'utf8') !== actual) {
        console.log(`  FAIL ${slug}/${probe.name}  projection changed`)
        problems++
        continue
      }
      console.log(`  ok   ${slug}/${probe.name}`)
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
    case 'requires': {
      // `requires` is derived and CI asserts the declared value matches; --write saves
      // transcribing it.
      const write = flags.includes('--write')
      for (const { slug, dir, manifest } of entries) {
        const derived = deriveRequires(manifest)
        if (!write) {
          console.log(`  ${slug}: ${JSON.stringify(derived)}`)
          continue
        }
        const path = join(dir, 'manifest.json')
        const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
        raw.requires = derived
        writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`)
        console.log(`  wrote requires for ${slug}`)
      }
      return 0
    }
    default:
      console.error('usage: catalog <validate|test|requires> [--write]')
      return 2
  }

  console.log('')
  const uncovered = coverage(entries)
  if (uncovered > 0) {
    console.log(`       ${uncovered} capability(ies) have no widget exercising them`)
  }
  const total = problems + uncovered
  console.log(total === 0 ? 'PASS' : `FAIL: ${total} problem(s)`)
  return total === 0 ? 0 : 1
}

process.exitCode = main()
