import { createHash } from 'node:crypto'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The asset store: user-supplied images, on disk, under a name the SERVER chose.
 *
 * Everything else in this app refuses to let a client name a URL or a path, and an upload is the
 * one place where that principle is easiest to lose — a filename from a browser is attacker-
 * controlled text that ends up as a path. So none of it is used. The name is the SHA-256 of the
 * bytes plus an extension derived from what the bytes actually are, which makes traversal
 * unexpressible rather than filtered: there is no input that reaches the path.
 *
 * The type is sniffed from magic bytes rather than believed from `Content-Type`. A declared
 * `image/png` proves nothing, and the file is later served back with a type header — so deciding
 * from the header would let someone store an HTML document and have it served as one, on the same
 * origin as the dashboard.
 *
 * Content addressing also means uploading the same wallpaper twice is idempotent rather than a
 * second copy, which matters for a directory the user is expected to commit to git.
 */

/** The formats a browser can actually paint as a background, and their magic bytes. */
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

/** Generous for a wallpaper, small enough that a mistake cannot fill a homelab's disk. */
export const MAX_ASSET_BYTES = 12 * 1024 * 1024

export const BACKGROUNDS_SUBDIR = 'backgrounds'

export type Asset = {
  readonly id: string
  readonly url: string
  readonly bytes: number
}

export class AssetError extends Error {
  // Assigned in the body rather than declared as a parameter property: the server runs straight
  // from source under Node's type-stripping, which cannot emit the assignment a parameter property
  // implies. Anything needing a real transform would break `node src/server/main.ts`.
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

/** `a1b2c3d4….png` — content addressed, so the id IS the integrity check. */
export function assetMime(id: string): string {
  const ext = id.slice(id.lastIndexOf('.') + 1)
  return SIGNATURES.find((signature) => signature.ext === ext)?.mime ?? 'application/octet-stream'
}

/**
 * An id is only ever produced by `saveBackground`, but it arrives back from a client on the way to
 * a filesystem read, so it is re-validated against the shape this module emits rather than trusted
 * for having been ours once.
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
    // A file the store did not write — dropped in by hand, or left by another tool — is listed
    // only if it matches the shape this module serves. Anything else is ignored rather than
    // offered, because the serve route will refuse it anyway.
    if (!isAssetId(name)) continue
    try {
      const info = await stat(join(directory, name))
      if (info.isFile()) {
        assets.push({ id: name, url: `/assets/${BACKGROUNDS_SUBDIR}/${name}`, bytes: info.size })
      }
    } catch {
      // Vanished between readdir and stat. Not an error worth failing a listing over.
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
