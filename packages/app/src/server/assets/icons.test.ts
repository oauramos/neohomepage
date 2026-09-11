import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IconStore, MAX_ICON_BYTES, type IconFetch } from './icons.ts'

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

    // A second store over the same directory knows the icon without asking anyone.
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
