import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  manifestSchema,
  SUPPORTED_MANIFEST_VERSIONS,
  type Manifest,
} from '@neohomepage/catalog-schema'

/**
 * Manifests loaded from a directory; a malformed manifest is rejected on its own and the rest
 * still load.
 */
export type CatalogLoad = {
  readonly manifests: ReadonlyMap<string, Manifest>
  readonly rejected: readonly { slug: string; reason: string }[]
}

export async function loadCatalogDirectory(directory: string): Promise<CatalogLoad> {
  const manifests = new Map<string, Manifest>()
  const rejected: { slug: string; reason: string }[] = []

  let slugs: string[]
  try {
    slugs = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { manifests, rejected }
    throw error
  }

  for (const slug of slugs) {
    try {
      const raw: unknown = JSON.parse(
        await readFile(join(directory, slug, 'manifest.json'), 'utf8'),
      )
      const version = (raw as { manifestVersion?: unknown }).manifestVersion
      if (typeof version !== 'number' || !SUPPORTED_MANIFEST_VERSIONS.includes(version as 1)) {
        // Refused at load rather than discovered at render time as a widget that shows nothing.
        rejected.push({
          slug,
          reason:
            `manifestVersion ${String(version)} is not supported by this build ` +
            `(supported: ${SUPPORTED_MANIFEST_VERSIONS.join(', ')})`,
        })
        continue
      }
      const parsed = manifestSchema.safeParse(raw)
      if (!parsed.success) {
        rejected.push({
          slug,
          reason: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        })
        continue
      }
      manifests.set(parsed.data.id, parsed.data)
    } catch (error) {
      rejected.push({ slug, reason: error instanceof Error ? error.message : String(error) })
    }
  }

  return { manifests, rejected }
}
