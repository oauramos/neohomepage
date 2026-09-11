import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Service icons, by reference.
 *
 * A manifest names its icon by slug (`adguard-home`); so does a bookmark. The reference is the
 * only thing config ever holds — the URL it becomes is built here, against one of three sets this
 * build names — and the file is fetched once into `state/icons/`, a cache that is rebuilt when
 * deleted. The page then references the LOCAL copy, so a published dashboard never loads anything
 * from the internet on view and works the same on a LAN that has none.
 *
 * Five sets, told apart by prefix, the way gethomepage spells them:
 *
 *   nextcloud               dashboard-icons: full-colour logos of self-hosted things
 *   si-nextcloud            Simple Icons: one-colour brand marks, served in the brand colour
 *   si-claude-#D97757       the same, in a colour you chose
 *   lucide-search           Lucide: the interface glyphs shadcn and ReUI ship, painted in the
 *                           text colour (a mask) — or in a colour you chose, `-#hex`
 *   tabler-search           Tabler Icons, the same way
 *   mdi-router-network      Material Design Icons, the same way
 *
 * Offline network mode disables the fetch, and a reference that is absent renders as an initial in
 * a rounded square rather than a broken image. Misses are remembered for a while so a typo is not
 * a request to a CDN on every rebuild.
 */

export const ICONS_SUBDIR = 'icons'

/** The five sets. Fixed here: nothing in config names a host. Package sets are pinned to a major. */
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

/** The reference grammar. One regex, so the schema, the editor and the store agree on it. */
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
  // A dashboard-icons logo is full colour already; a colour on it means nothing and is refused.
  if (source === 'dashboard' && color !== undefined) return null
  return { source, slug, color: color === undefined ? null : color.toLowerCase() }
}

/** The file stem a reference is cached under — also the tail of its `/assets/icons/` URL. */
export function iconKey(ref: IconRef): string {
  const prefix =
    ref.source === 'dashboard' ? '' : ref.source === 'simple' ? 'si-' : `${ref.source}-`
  return `${prefix}${ref.slug}${ref.color === null ? '' : `-${ref.color}`}`
}

/**
 * How the page draws it: an image as-is, or a mask painted in a colour. The glyph sets ship black
 * shapes — strokes for Lucide and Tabler, fills for MDI — and a mask is what makes them read on
 * every theme.
 */
export function iconMode(ref: IconRef): 'image' | 'mask' {
  return ref.source === 'dashboard' || ref.source === 'simple' ? 'image' : 'mask'
}

/** The URLs to try, in order. Only dashboard-icons has a PNG fallback. */
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

/** The largest icon in the set at the time of writing is a 240 KB SVG; this caps a surprise. */
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

  /** The keys the renderer may reference: each has a file on disk. */
  available(): ReadonlySet<string> {
    return new Set(this.#available.keys())
  }

  /**
   * The cached file for a key, and its type — served at `/assets/icons/<key>`, without an
   * extension, so the resolver can name the URL from the reference alone and the store stays the
   * only thing that knows whether the SVG or the PNG fallback is what arrived.
   */
  fileFor(key: string): { path: string; mime: string } | null {
    const ext = this.#available.get(key)
    if (ext === undefined || !isIconFile(`${key}.${ext}`)) return null
    return { path: join(this.#dir, `${key}.${ext}`), mime: iconMime(`${key}.${ext}`) }
  }

  /**
   * Fetch what is missing, a few at a time. Resolves to the keys that ARRIVED, so the caller
   * knows whether anything changed and a rebuild is worth it.
   */
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
      } catch {
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
