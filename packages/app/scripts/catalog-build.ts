/**
 * Build the published catalog.
 *
 * Two files, and the split is the whole design:
 *
 *   latest.json          ~300 bytes, mutable, points at the payload by content hash
 *   catalog-<sha>.json   the manifests, immutable because its name IS its hash
 *
 * That shape fixes four things at once. GitHub Pages sends an unconfigurable `max-age=600`, which
 * only ever applies to the tiny pointer. Migration is a `movedTo` field on a stable URL. Integrity
 * is a sha256 the client re-checks, so the payload can be served from a second host. And pinning a
 * release is just remembering a hash.
 *
 * The whole catalog ships as ONE gzipped file rather than paginated or fetched per id: manifests
 * are structurally near-identical, so a bundle compresses about seven times better than the same
 * documents fetched separately. Revisit at a couple of thousand widgets, not before.
 */
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { auditManifest, deriveRequires, manifestSchema } from '@neohomepage/catalog-schema'
import { SUPPORTED_DECODERS } from '../src/server/decode/index.ts'
import { TEMPLATES } from '../src/shared/board.ts'

const CATALOG_DIR = resolve(process.env.NEOHOMEPAGE_CATALOG_DIR ?? '../../catalog')
const OUT_DIR = resolve(process.env.NEOHOMEPAGE_CATALOG_OUT ?? '../../catalog-dist')

/**
 * What this build of the app can actually render.
 *
 * Published alongside the catalog so a client can decide, before installing, whether a manifest
 * needs something it does not have — rather than installing it and rendering nothing, which is
 * the failure the whole capability contract exists to prevent.
 */
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

  const manifests: unknown[] = []
  let problems = 0

  for (const slug of slugs) {
    const path = join(CATALOG_DIR, slug, 'manifest.json')
    const parsed = manifestSchema.safeParse(JSON.parse(await readFile(path, 'utf8')))
    if (!parsed.success) {
      console.error(`FAIL ${slug}: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
      problems++
      continue
    }
    const found = auditManifest(parsed.data)
    for (const problem of found) console.error(`FAIL ${slug}: ${problem.path}: ${problem.message}`)
    problems += found.length
    if (found.length === 0)
      manifests.push({ ...parsed.data, requires: deriveRequires(parsed.data) })
  }

  if (problems > 0) {
    console.error(`\n${problems} problem(s); nothing published`)
    return 1
  }

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
        // Deliberately relative: the payload has to resolve from whichever host is serving the
        // pointer, so the same file works from Pages and from a mirror.
        payload: payloadName,
        sha256,
        count: manifests.length,
        // No build timestamp. Two builds of identical input must produce identical bytes, or
        // "reproducible" is a word rather than a property.
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
