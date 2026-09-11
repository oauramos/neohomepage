import { createHash } from 'node:crypto'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * User-supplied images on disk under a server-chosen name: the SHA-256 of the bytes plus an
 * extension sniffed from magic bytes, so no client input reaches a path and a stored HTML document
 * is never served as one on the dashboard's origin.
 */

/** Formats a browser can paint as a background, by magic bytes. */
const SIGNATURES: { ext: string; mime: string; match: (bytes: Uint8Array) => boolean }[] = [
  {
    ext: 'png',
    mime: 'image/png',
    match: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  {
    ext: 'jpg',
    mime: 'image/jpeg',
    match: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    ext: 'gif',
    mime: 'image/gif',
    match: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38,
  },
  {
    // RIFF....WEBP
    ext: 'webp',
    mime: 'image/webp',
    match: (b) =>
      b[0] === 0x52 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x46 &&
      b[8] === 0x57 &&
      b[9] === 0x45 &&
      b[10] === 0x42 &&
      b[11] === 0x50,
  },
  {
    // ....ftypavif — the brand sits at offset 8 in an ISO base media file.
    ext: 'avif',
    mime: 'image/avif',
    match: (b) =>
      b[4] === 0x66 &&
      b[5] === 0x74 &&
      b[6] === 0x79 &&
      b[7] === 0x70 &&
      b[8] === 0x61 &&
      b[9] === 0x76 &&
      b[10] === 0x69 &&
      b[11] === 0x66,
  },
]

export const MAX_ASSET_BYTES = 12 * 1024 * 1024

export const BACKGROUNDS_SUBDIR = 'backgrounds'

export type Asset = {
  readonly id: string
  readonly url: string
  readonly bytes: number
}

export class AssetError extends Error {
  // Assigned in the body, not a parameter property: Node's type stripping cannot emit one.
  readonly status: 400 | 413 | 415

  constructor(message: string, status: 400 | 413 | 415) {
    super(message)
    this.name = 'AssetError'
    this.status = status
  }
}

function sniff(bytes: Uint8Array): { ext: string; mime: string } {
  const found = SIGNATURES.find((signature) => signature.match(bytes))
  if (found === undefined) {
    throw new AssetError('not a PNG, JPEG, GIF, WebP or AVIF image', 415)
  }
  return { ext: found.ext, mime: found.mime }
}

export function assetMime(id: string): string {
  const ext = id.slice(id.lastIndexOf('.') + 1)
  return SIGNATURES.find((signature) => signature.ext === ext)?.mime ?? 'application/octet-stream'
}

/**
 * Ids come back from a client on the way to a filesystem read, so they are re-validated against
 * the shape this module emits.
 */
export function isAssetId(id: string): boolean {
  return /^[0-9a-f]{32}\.(png|jpg|gif|webp|avif)$/.test(id)
}

export async function saveBackground(assetsDir: string, bytes: Uint8Array): Promise<Asset> {
  if (bytes.length === 0) throw new AssetError('empty upload', 400)
  if (bytes.length > MAX_ASSET_BYTES) {
    throw new AssetError(`larger than ${String(MAX_ASSET_BYTES / 1024 / 1024)} MB`, 413)
  }
  if (bytes.length < 16) throw new AssetError('too short to be an image', 415)

  const { ext } = sniff(bytes)
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 32)
  const id = `${digest}.${ext}`

  const directory = join(assetsDir, BACKGROUNDS_SUBDIR)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, id), bytes)

  return { id, url: `/assets/${BACKGROUNDS_SUBDIR}/${id}`, bytes: bytes.length }
}

export async function listBackgrounds(assetsDir: string): Promise<Asset[]> {
  const directory = join(assetsDir, BACKGROUNDS_SUBDIR)
  let names: string[]
  try {
    names = await readdir(directory)
  } catch {
    return []
  }

  const assets: Asset[] = []
  for (const name of names) {
    // Only files of the shape this module serves are listed; the serve route refuses anything else.
    if (!isAssetId(name)) continue
    try {
      const info = await stat(join(directory, name))
      if (info.isFile()) {
        assets.push({ id: name, url: `/assets/${BACKGROUNDS_SUBDIR}/${name}`, bytes: info.size })
      }
    } catch {
      // Vanished between readdir and stat.
    }
  }
  return assets.sort((a, b) => a.id.localeCompare(b.id))
}

export async function deleteBackground(assetsDir: string, id: string): Promise<boolean> {
  if (!isAssetId(id)) return false
  try {
    await rm(join(assetsDir, BACKGROUNDS_SUBDIR, id))
    return true
  } catch {
    return false
  }
}
