import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  IconStore,
  MAX_ICON_BYTES,
  iconKey,
  iconMode,
  parseIconRef,
  type IconFetch,
} from './icons.ts'

const created: string[] = []
afterEach(async () => {
  while (created.length > 0) await rm(created.pop() as string, { recursive: true, force: true })
})

async function stateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'neo-icons-'))
  created.push(dir)
  return dir
}

const SVG = new TextEncoder().encode(
  '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>',
)
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

/** A CDN in a map: url -> bytes, and a log of what was asked for. */
function cdn(files: Record<string, Uint8Array>): { fetch: IconFetch; asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    fetch: async (url) => {
      asked.push(url)
      return files[url] ?? null
    },
  }
}

const SVG_URL = (slug: string) =>
  `https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/${slug}.svg`
const PNG_URL = (slug: string) =>
  `https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/${slug}.png`

describe('the icon store', () => {
  it('fetches a missing slug once, caches it, and serves it from the cache after a reload', async () => {
    const dir = await stateDir()
    const fake = cdn({ [SVG_URL('nextcloud')]: SVG })
    const store = new IconStore(dir, fake.fetch)
    await store.load()

    expect(await store.ensure(['nextcloud'], { offline: false })).toEqual(['nextcloud'])
    expect(store.available().has('nextcloud')).toBe(true)
    expect(store.fileFor('nextcloud')).toMatchObject({ mime: 'image/svg+xml' })
    expect(await readdir(join(dir, 'icons'))).toEqual(['nextcloud.svg'])

    const again = new IconStore(dir, fake.fetch)
    await again.load()
    expect(await again.ensure(['nextcloud'], { offline: false })).toEqual([])
    expect(fake.asked).toHaveLength(1)
  })

  it('falls back to the PNG when the set has no SVG for a slug', async () => {
    const dir = await stateDir()
    const fake = cdn({ [PNG_URL('sftpgo')]: PNG })
    const store = new IconStore(dir, fake.fetch)
    await store.load()
    expect(await store.ensure(['sftpgo'], { offline: false })).toEqual(['sftpgo'])
    expect(store.fileFor('sftpgo')).toMatchObject({ mime: 'image/png' })
    expect(fake.asked).toEqual([SVG_URL('sftpgo'), PNG_URL('sftpgo')])
  })

  it('remembers a miss, so a typo is not a request on every rebuild', async () => {
    const dir = await stateDir()
    const fake = cdn({})
    const store = new IconStore(dir, fake.fetch)
    await store.load()
    expect(await store.ensure(['nextclod'], { offline: false })).toEqual([])
    expect(await store.ensure(['nextclod'], { offline: false })).toEqual([])
    expect(fake.asked).toHaveLength(2) // svg then png, once
    expect(store.fileFor('nextclod')).toBeNull()
  })

  it('fetches nothing offline, and nothing for a slug that is not a slug', async () => {
    const dir = await stateDir()
    const fake = cdn({ [SVG_URL('nextcloud')]: SVG })
    const store = new IconStore(dir, fake.fetch)
    await store.load()
    expect(await store.ensure(['nextcloud'], { offline: true })).toEqual([])
    expect(await store.ensure(['../../etc/passwd', 'Nextcloud'], { offline: false })).toEqual([])
    expect(fake.asked).toEqual([])
  })

  it('refuses a file that is not the image it claims to be', async () => {
    // Served back from the dashboard's own origin, so an HTML document named .svg would be a page.
    const dir = await stateDir()
    const html = new TextEncoder().encode('<!doctype html><html><script>alert(1)</script></html>')
    const scripted = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    )
    const fake = cdn({
      [SVG_URL('evil')]: html,
      [SVG_URL('sneaky')]: scripted,
      [PNG_URL('sneaky')]: SVG,
    })
    const store = new IconStore(dir, fake.fetch)
    await store.load()
    expect(await store.ensure(['evil', 'sneaky'], { offline: false })).toEqual([])
    expect(await readdir(join(dir, 'icons'))).toEqual([])
  })

  it('ignores files in the cache directory that are not icons', async () => {
    const dir = await stateDir()
    await mkdir(join(dir, 'icons'), { recursive: true })
    await writeFile(join(dir, 'icons', 'notes.txt'), 'x')
    await writeFile(join(dir, 'icons', 'Bad Name.svg'), 'x')
    await writeFile(join(dir, 'icons', 'plex.svg'), SVG)
    const store = new IconStore(dir, cdn({}).fetch)
    await store.load()
    expect([...store.available()]).toEqual(['plex'])
  })

  it('caps what it will accept', () => {
    expect(MAX_ICON_BYTES).toBeLessThanOrEqual(1024 * 1024)
  })
})

describe('icon references', () => {
  it('reads the five sets by prefix, with an optional colour, the way gethomepage spells them', () => {
    expect(parseIconRef('nextcloud')).toEqual({
      source: 'dashboard',
      slug: 'nextcloud',
      color: null,
    })
    expect(parseIconRef('adguard-home')).toEqual({
      source: 'dashboard',
      slug: 'adguard-home',
      color: null,
    })
    expect(parseIconRef('si-nextcloud')).toEqual({
      source: 'simple',
      slug: 'nextcloud',
      color: null,
    })
    expect(parseIconRef('si-claude-#D97757')).toEqual({
      source: 'simple',
      slug: 'claude',
      color: 'd97757',
    })
    expect(parseIconRef('mdi-router-network')).toEqual({
      source: 'mdi',
      slug: 'router-network',
      color: null,
    })
    expect(parseIconRef('lucide-search')).toEqual({ source: 'lucide', slug: 'search', color: null })
    expect(parseIconRef('tabler-router')).toEqual({ source: 'tabler', slug: 'router', color: null })
    expect(parseIconRef('lucide-hard-drive-#FF6900')).toEqual({
      source: 'lucide',
      slug: 'hard-drive',
      color: 'ff6900',
    })
    expect(parseIconRef('mdi-router-network-#FF6900')).toEqual({
      source: 'mdi',
      slug: 'router-network',
      color: 'ff6900',
    })
  })

  it('refuses what none of the sets could mean', () => {
    for (const bad of [
      'Nextcloud',
      'si-',
      'si-adguard-home',
      'nextcloud-#ff0000',
      'x-#12',
      '../etc',
      'a b',
    ]) {
      expect(parseIconRef(bad), bad).toBeNull()
    }
  })

  it('keys a reference so two colours of one glyph are two files, and MDI is drawn as a mask', () => {
    const plain = parseIconRef('mdi-router-network')
    const tinted = parseIconRef('mdi-router-network-#ff6900')
    if (plain === null || tinted === null) throw new Error('unreachable')
    expect(iconKey(plain)).toBe('mdi-router-network')
    expect(iconKey(tinted)).toBe('mdi-router-network-ff6900')
    expect(iconMode(plain)).toBe('mask')
    const glyph = parseIconRef('lucide-search')
    if (glyph === null) throw new Error('unreachable')
    expect(iconKey(glyph)).toBe('lucide-search')
    expect(iconMode(glyph)).toBe('mask')
    const brand = parseIconRef('si-nextcloud')
    if (brand === null) throw new Error('unreachable')
    expect(iconMode(brand)).toBe('image')
  })

  it('fetches Simple Icons in the brand colour, or the colour named, and MDI from its package', async () => {
    const dir = await stateDir()
    const fake = cdn({
      'https://cdn.simpleicons.org/nextcloud': SVG,
      'https://cdn.simpleicons.org/claude/d97757': SVG,
      'https://cdn.jsdelivr.net/npm/@mdi/svg@7/svg/router-network.svg': SVG,
      'https://cdn.jsdelivr.net/npm/lucide-static@1/icons/search.svg': new TextEncoder().encode(
        '<!-- @license lucide-static v1.45.0 - ISC -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/></svg>',
      ),
    })
    const store = new IconStore(dir, fake.fetch)
    await store.load()
    const arrived = await store.ensure(
      ['si-nextcloud', 'si-claude-#D97757', 'mdi-router-network', 'lucide-search', 'si-nope'],
      { offline: false },
    )
    // Lucide files open with a licence comment; that is still an SVG.
    expect(arrived.sort()).toEqual([
      'lucide-search',
      'mdi-router-network',
      'si-claude-d97757',
      'si-nextcloud',
    ])
    expect(fake.asked).toContain('https://cdn.simpleicons.org/claude/d97757')
    // No PNG fallback for these sets: one request per reference, not two.
    expect(fake.asked.filter((url) => url.includes('simpleicons'))).toHaveLength(3)
    expect((await readdir(join(dir, 'icons'))).sort()).toEqual([
      'lucide-search.svg',
      'mdi-router-network.svg',
      'si-claude-d97757.svg',
      'si-nextcloud.svg',
    ])
  })
})
