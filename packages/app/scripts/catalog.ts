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

const CATALOG_DIR = resolve(process.env.NEOHOMEPAGE_CATALOG_DIR ?? '../../catalog')

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
 * One recorded upstream response and the projections run against it.
 *
 * Both manifest shapes reduce to this. A single-target widget has one probe per operation with a
 * single projection; a composite has one probe per source kind whose several emits all read the
 * SAME decoded response — which is the fan-out, tested as the fan-out rather than as N fetches.
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
  for (const { slug, manifest } of entries) {
    const found = auditManifest(manifest)
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

/**
 * What the catalog exercises, as a set difference against what the app can do.
 *
 * Printed because "16 manifests" is not evidence of coverage: sixteen widgets that all speak JSON
 * over a header auth into a stat-grid would leave three quarters of the runtime untested while
 * looking like a full catalog.
 */
function coverage(entries: readonly Entry[]): void {
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

    // Defaults where they exist, and a sample value for anything required without one. Otherwise
    // a manifest with a required option is untestable: its projection would run with null and
    // fail the render contract for a reason that has nothing to do with the manifest.
    const options = Object.fromEntries(
      manifest.config.map((field) => [field.name, field.default ?? sampleFor(field)]),
    ) as Record<string, Json>

    for (const probe of probesOf(manifest)) {
      const extension = FIXTURE_EXTENSION[probe.decode]
      const upstreamPath = join(fixtures, `${probe.name}.upstream.${extension}`)
      const expectedPath = join(fixtures, `${probe.name}.expected.json`)
      if (!existsSync(upstreamPath)) {
        console.log(`  FAIL ${slug}/${probe.name}  missing ${probe.name}.upstream.${extension}`)
        problems++
        continue
      }

      // Through the real decoder, so an .ics fixture proves the ICS path offline rather than a
      // hand-written JSON approximation of what the decoder is assumed to emit.
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
      if (probe.concatItems) value = { items } as Json

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
      /**
       * `requires` is derived and CI asserts it matches what the author declared — so an author
       * needs a way to write the derived value rather than transcribing it. The assertion is what
       * matters; hand-transcription is just friction that produces drift.
       */
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
  coverage(entries)
  console.log(problems === 0 ? 'PASS' : `FAIL: ${problems} problem(s)`)
  return problems === 0 ? 0 : 1
}

process.exitCode = main()
