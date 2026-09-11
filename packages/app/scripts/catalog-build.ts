/**
 * Builds the published catalog: a small mutable `latest.json` pointer (the only file GitHub Pages'
 * fixed `max-age=600` matters for) and an immutable `catalog-<sha>.json` payload named by its hash.
 */
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { join, resolve } from 'node:path'
import process from 'node:process'
import {
  auditManifest,
  deriveRequires,
  parseManifest,
  type Manifest,
} from '@neohomepage/catalog-schema'
import { SUPPORTED_DECODERS } from '../src/server/decode/index.ts'
import { TEMPLATES } from '../src/shared/board.ts'

const ROOT = resolve(import.meta.dirname, '../../..')
const CATALOG_DIR = resolve(process.env.NEOHOMEPAGE_CATALOG_DIR ?? join(ROOT, 'catalog'))
const OUT_DIR = resolve(process.env.NEOHOMEPAGE_CATALOG_OUT ?? join(ROOT, 'catalog-dist'))

/** What this build can render, published so a client can reject a manifest before installing it. */
function capabilities() {
  return {
    templates: [...TEMPLATES].sort(),
    fetchKinds: [...SUPPORTED_DECODERS].sort(),
  }
}

async function main(): Promise<number> {
  const slugs = (await readdir(CATALOG_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  const manifests: Manifest[] = []
  let problems = 0

  for (const slug of slugs) {
    const path = join(CATALOG_DIR, slug, 'manifest.json')
    const parsed = parseManifest(JSON.parse(await readFile(path, 'utf8')))
    if (!parsed.ok) {
      console.error(
        `FAIL ${slug}: ${parsed.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
      )
      problems++
      continue
    }
    const found = auditManifest(parsed.manifest)
    for (const problem of found) console.error(`FAIL ${slug}: ${problem.path}: ${problem.message}`)
    problems += found.length
    if (found.length === 0)
      manifests.push({ ...parsed.manifest, requires: deriveRequires(parsed.manifest) })
  }

  if (problems > 0) {
    console.error(`\n${problems} problem(s); nothing published`)
    return 1
  }

  // One bundle rather than per-id files: near-identical manifests gzip about seven times better
  // together. Revisit at a couple of thousand widgets.
  const payload = `${JSON.stringify({ manifests, capabilities: capabilities() }, null, 0)}\n`
  const sha256 = createHash('sha256').update(payload).digest('hex')
  const payloadName = `catalog-${sha256.slice(0, 16)}.json`

  await rm(OUT_DIR, { recursive: true, force: true })
  await mkdir(join(OUT_DIR, 'v1'), { recursive: true })
  await writeFile(join(OUT_DIR, 'v1', payloadName), payload)
  await writeFile(
    join(OUT_DIR, 'v1', 'latest.json'),
    `${JSON.stringify(
      {
        // Relative so the pointer resolves from whichever host serves it.
        payload: payloadName,
        sha256,
        count: manifests.length,
        // Present and null so today's clients already read it when the catalog moves host.
        movedTo: null,
        // No build timestamp: identical input must produce identical bytes.
      },
      null,
      2,
    )}\n`,
  )

  const gzipped = gzipSync(Buffer.from(payload, 'utf8')).length
  console.log(`catalog: ${manifests.length} manifest(s)`)
  console.log(`  ${join(OUT_DIR, 'v1', payloadName)}`)
  console.log(
    `  ${(payload.length / 1024).toFixed(1)} KiB raw, ${(gzipped / 1024).toFixed(1)} KiB gzip`,
  )
  console.log(`  sha256 ${sha256}`)
  return 0
}

process.exitCode = await main()
