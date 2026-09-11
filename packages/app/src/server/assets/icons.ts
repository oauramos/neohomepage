import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Service icons by reference: config holds a slug, the file is fetched once into `state/icons/`
 * and the page references the local copy, so a published dashboard loads nothing from the internet.
 *
 * Reference prefixes, spelled as gethomepage does:
 *   nextcloud             dashboard-icons, full-colour logo
 *   si-nextcloud          Simple Icons, brand colour; `si-claude-#D97757` in a chosen colour
 *   lucide-x / tabler-x / mdi-x
 *                         glyph sets painted as a mask in the text colour, or `-#hex`
 */

export const ICONS_SUBDIR = 'icons'

/** Hosts are fixed here, never named by config; package sets are pinned to a major. */
const DASHBOARD_ICONS = 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons'
const SIMPLE_ICONS = 'https://cdn.simpleicons.org'
const LUCIDE = 'https://cdn.jsdelivr.net/npm/lucide-static@1/icons'
const TABLER = 'https://cdn.jsdelivr.net/npm/@tabler/icons@3/icons/outline'
const MDI = 'https://cdn.jsdelivr.net/npm/@mdi/svg@7/svg'

const FORMATS = [
  { ext: 'svg', mime: 'image/svg+xml' },
  { ext: 'png', mime: 'image/png' },
] as const

export type IconSource = 'dashboard' | 'simple' | 'lucide' | 'tabler' | 'mdi'

export type IconRef = {
  readonly source: IconSource
  readonly slug: string
  /** Six hex digits, lowercase, no `#`; null for the set's own colour. */
  readonly color: string | null
}

/** Reference grammar, shared by the schema, the editor and the store. */
export const ICON_REF =
  /^(?:(si|lucide|tabler|mdi)-)?([a-z0-9][a-z0-9-]{0,63}?)(?:-#([0-9a-fA-F]{6}))?$/

const SOURCES: Record<string, IconSource> = {
  si: 'simple',
  lucide: 'lucide',
  tabler: 'tabler',
  mdi: 'mdi',
}

export function parseIconRef(reference: string): IconRef | null {
  const match = ICON_REF.exec(reference)
  if (match === null) return null
  const [, prefix, slug, color] = match
  if (slug === undefined || slug === '' || slug.endsWith('-')) return null
  const source: IconSource = prefix === undefined ? 'dashboard' : (SOURCES[prefix] ?? 'dashboard')
  // Simple Icons slugs carry no hyphen; a hyphenated one is a dashboard-icons name by mistake.
  if (source === 'simple' && slug.includes('-')) return null
  // dashboard-icons logos are full colour already; a colour on one is refused.
  if (source === 'dashboard' && color !== undefined) return null
  return { source, slug, color: color === undefined ? null : color.toLowerCase() }
}

/** The file stem a reference is cached under — also the tail of its `/assets/icons/` URL. */
export function iconKey(ref: IconRef): string {
  const prefix =
    ref.source === 'dashboard' ? '' : ref.source === 'simple' ? 'si-' : `${ref.source}-`
  return `${prefix}${ref.slug}${ref.color === null ? '' : `-${ref.color}`}`
}

/** Glyph sets ship black shapes, so they are painted as a mask to read on every theme. */
export function iconMode(ref: IconRef): 'image' | 'mask' {
  return ref.source === 'dashboard' || ref.source === 'simple' ? 'image' : 'mask'
}

function candidates(ref: IconRef): { url: string; ext: 'svg' | 'png' }[] {
  switch (ref.source) {
    case 'simple':
      return [
        {
          url: `${SIMPLE_ICONS}/${ref.slug}${ref.color === null ? '' : `/${ref.color}`}`,
          ext: 'svg',
        },
      ]
    case 'lucide':
      return [{ url: `${LUCIDE}/${ref.slug}.svg`, ext: 'svg' }]
    case 'tabler':
      return [{ url: `${TABLER}/${ref.slug}.svg`, ext: 'svg' }]
    case 'mdi':
      return [{ url: `${MDI}/${ref.slug}.svg`, ext: 'svg' }]
    case 'dashboard':
      return [
        { url: `${DASHBOARD_ICONS}/svg/${ref.slug}.svg`, ext: 'svg' },
        { url: `${DASHBOARD_ICONS}/png/${ref.slug}.png`, ext: 'png' },
      ]
  }
}

/** The largest known icon is a 240 KB SVG. */
export const MAX_ICON_BYTES = 512 * 1024

const MISS_TTL_MS = 60 * 60 * 1000

export function iconMime(file: string): string {
  const ext = file.slice(file.lastIndexOf('.') + 1)
  return FORMATS.find((format) => format.ext === ext)?.mime ?? 'application/octet-stream'
}

/** A cache file is `<key>.<ext>`, where the key is what `iconKey` produces and nothing else. */
export function isIconFile(file: string): boolean {
  const dot = file.lastIndexOf('.')
  if (dot <= 0) return false
  const ext = file.slice(dot + 1)
  if (ext !== 'svg' && ext !== 'png') return false
  const key = file.slice(0, dot)
  return (
    /^(?:si-|lucide-|tabler-|mdi-)?[a-z0-9][a-z0-9-]{0,63}(?:-[0-9a-f]{6})?$/.test(key) &&
    key.length <= 90
  )
}

/** Bytes of a URL, or null for anything but a 200 within the cap. */
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

  /** Reads the cache from disk so a restart does not refetch. */
  async load(): Promise<void> {
    await mkdir(this.#dir, { recursive: true })
    this.#available.clear()
    for (const file of await readdir(this.#dir)) {
      if (!isIconFile(file)) continue
      const dot = file.lastIndexOf('.')
      this.#available.set(file.slice(0, dot), file.slice(dot + 1))
    }
  }

  /** The keys the renderer may reference: each has a file on disk. */
  available(): ReadonlySet<string> {
    return new Set(this.#available.keys())
  }

  /**
   * Served at `/assets/icons/<key>` without an extension, so only the store knows whether the SVG
   * or the PNG fallback arrived.
   */
  fileFor(key: string): { path: string; mime: string } | null {
    const ext = this.#available.get(key)
    if (ext === undefined || !isIconFile(`${key}.${ext}`)) return null
    return { path: join(this.#dir, `${key}.${ext}`), mime: iconMime(`${key}.${ext}`) }
  }

  /** Resolves to the keys that arrived, so the caller knows whether a rebuild is worth it. */
  async ensure(references: Iterable<string>, options: { offline: boolean }): Promise<string[]> {
    if (options.offline) return []
    const wanted = new Map<string, IconRef>()
    for (const reference of references) {
      const ref = parseIconRef(reference)
      if (ref === null) continue
      const key = iconKey(ref)
      if (this.#available.has(key)) continue
      if (Date.now() - (this.#missedAt.get(key) ?? 0) <= MISS_TTL_MS) continue
      wanted.set(key, ref)
    }
    const arrived: string[] = []
    const queue = [...wanted.entries()]
    const worker = async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        const [key, ref] = next
        if (await this.#fetchOne(key, ref)) arrived.push(key)
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker))
    return arrived
  }

  #fetchOne(key: string, ref: IconRef): Promise<boolean> {
    const pending = this.#inFlight.get(key)
    if (pending !== undefined) return pending
    const job = (async () => {
      try {
        for (const candidate of candidates(ref)) {
          const bytes = await this.#fetch(candidate.url, MAX_ICON_BYTES)
          if (bytes === null || bytes.length === 0) continue
          if (candidate.ext === 'svg' && !looksLikeSvg(bytes)) continue
          if (candidate.ext === 'png' && !looksLikePng(bytes)) continue
          await writeFile(join(this.#dir, `${key}.${candidate.ext}`), bytes)
          this.#available.set(key, candidate.ext)
          return true
        }
        this.#missedAt.set(key, Date.now())
        return false
      } catch (error) {
        // The fetch returns null rather than throwing, so this is the local write or the decoder.
        console.warn(`icons: ${key}: ${error instanceof Error ? error.message : String(error)}`)
        this.#missedAt.set(key, Date.now())
        return false
      } finally {
        this.#inFlight.delete(key)
      }
    })()
    this.#inFlight.set(key, job)
    return job
  }
}

/**
 * The file is served from this origin, so it must be the image it claims: an HTML document saved
 * as `.svg` would be a page on the dashboard's origin.
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
