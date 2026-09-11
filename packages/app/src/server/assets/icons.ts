import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Service icons, by slug.
 *
 * A manifest names its icon by slug (`adguard-home`); so does a bookmark. The slug is the only
 * thing config ever holds — the URL it becomes is built here, against one CDN this build names —
 * and the file is fetched once into `state/icons/`, a cache that is rebuilt when deleted. The
 * page then references the LOCAL copy, so a published dashboard never loads anything from the
 * internet on view and works the same on a LAN that has none.
 *
 * Offline network mode disables the fetch, and a slug that is absent renders as an initial in a
 * rounded square rather than a broken image. Misses are remembered for a while so a typo in an
 * icon name is not a request to the CDN on every rebuild.
 */

export const ICONS_SUBDIR = 'icons'

/** dashboard-icons — the set gethomepage, Homarr and most dashboards name their icons from. */
const CDN = 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons'

/** SVG first for the crisp one; the PNG is the fallback for the few icons that have no vector. */
const FORMATS = [
  { ext: 'svg', path: 'svg', mime: 'image/svg+xml' },
  { ext: 'png', path: 'png', mime: 'image/png' },
] as const

/** The largest icon in the set at the time of writing is a 240 KB SVG; this caps a surprise. */
export const MAX_ICON_BYTES = 512 * 1024

const MISS_TTL_MS = 60 * 60 * 1000

export const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/

export function iconMime(file: string): string {
  const ext = file.slice(file.lastIndexOf('.') + 1)
  return FORMATS.find((format) => format.ext === ext)?.mime ?? 'application/octet-stream'
}

export function isIconFile(file: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}\.(svg|png)$/.test(file)
}

/** What a fetch must provide: the bytes of a URL, or null for anything but a 200 within the cap. */
export type IconFetch = (url: string, maxBytes: number) => Promise<Uint8Array | null>

export class IconStore {
  readonly #dir: string
  readonly #fetch: IconFetch
  readonly #available = new Map<string, string>()
  readonly #missedAt = new Map<string, number>()
  readonly #inFlight = new Map<string, Promise<boolean>>()

  constructor(stateDir: string, fetch: IconFetch) {
    this.#dir = join(stateDir, ICONS_SUBDIR)
    this.#fetch = fetch
  }

  /** Read what the cache already holds; a restart must not refetch a hundred icons. */
  async load(): Promise<void> {
    await mkdir(this.#dir, { recursive: true })
    this.#available.clear()
    for (const file of await readdir(this.#dir)) {
      if (!isIconFile(file)) continue
      const dot = file.lastIndexOf('.')
      this.#available.set(file.slice(0, dot), file.slice(dot + 1))
    }
  }

  /** The slugs the renderer may reference: each has a file on disk. */
  available(): ReadonlySet<string> {
    return new Set(this.#available.keys())
  }

  /**
   * The cached file for a slug, and its type — served at `/assets/icons/<slug>`, without an
   * extension, so the resolver can name the URL from the slug alone and the store stays the only
   * thing that knows whether the SVG or the PNG fallback is what arrived.
   */
  fileFor(slug: string): { path: string; mime: string } | null {
    const ext = this.#available.get(slug)
    if (ext === undefined || !SLUG.test(slug)) return null
    return { path: join(this.#dir, `${slug}.${ext}`), mime: iconMime(`${slug}.${ext}`) }
  }

  /**
   * Fetch what is missing, a few at a time. Resolves to the slugs that ARRIVED, so the caller
   * knows whether anything changed and a rebuild is worth it.
   */
  async ensure(slugs: Iterable<string>, options: { offline: boolean }): Promise<string[]> {
    if (options.offline) return []
    const wanted = [...new Set(slugs)].filter(
      (slug) =>
        SLUG.test(slug) &&
        !this.#available.has(slug) &&
        Date.now() - (this.#missedAt.get(slug) ?? 0) > MISS_TTL_MS,
    )
    const arrived: string[] = []
    const queue = [...wanted]
    const worker = async () => {
      for (let slug = queue.shift(); slug !== undefined; slug = queue.shift()) {
        if (await this.#fetchOne(slug)) arrived.push(slug)
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker))
    return arrived
  }

  #fetchOne(slug: string): Promise<boolean> {
    const pending = this.#inFlight.get(slug)
    if (pending !== undefined) return pending
    const job = (async () => {
      try {
        for (const format of FORMATS) {
          const bytes = await this.#fetch(
            `${CDN}/${format.path}/${slug}.${format.ext}`,
            MAX_ICON_BYTES,
          )
          if (bytes === null || bytes.length === 0) continue
          if (format.ext === 'svg' && !looksLikeSvg(bytes)) continue
          if (format.ext === 'png' && !looksLikePng(bytes)) continue
          await writeFile(join(this.#dir, `${slug}.${format.ext}`), bytes)
          this.#available.set(slug, format.ext)
          return true
        }
        this.#missedAt.set(slug, Date.now())
        return false
      } catch {
        this.#missedAt.set(slug, Date.now())
        return false
      } finally {
        this.#inFlight.delete(slug)
      }
    })()
    this.#inFlight.set(slug, job)
    return job
  }
}

/**
 * The file is served back from this origin, so what is stored must be the image it claims to be
 * — an HTML document saved as `.svg` would be a page on the dashboard's origin. The check is on
 * the bytes: an SVG is an XML document whose root is `<svg`, a PNG starts with its signature.
 */
function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, 512))
    .replace(/^\uFEFF/, '')
    .trimStart()
  const withoutPrologue = head
    .replace(/^<\?xml[^>]*\?>\s*/i, '')
    .replace(/^(<!--[\s\S]*?-->\s*)*/, '')
  const withoutDoctype = withoutPrologue.replace(/^<!DOCTYPE[^>]*>\s*/i, '')
  return (
    /^<svg[\s>]/i.test(withoutDoctype) && !/<script[\s>]/i.test(new TextDecoder().decode(bytes))
  )
}

function looksLikePng(bytes: Uint8Array): boolean {
  return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
}
