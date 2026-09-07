import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FAVICON_HREF, FAVICON_SVG } from './favicon.ts'

describe('the tab icon', () => {
  it('is a legal attribute value with nothing left to escape', () => {
    expect(FAVICON_HREF).not.toContain('<')
    expect(FAVICON_HREF).not.toContain('>')
    expect(FAVICON_HREF).not.toContain('"')
    expect(FAVICON_HREF).not.toContain('#')
    expect(FAVICON_HREF.startsWith('data:image/svg+xml,')).toBe(true)
  })

  it('round-trips back to the SVG a browser will parse', () => {
    const decoded = decodeURIComponent(FAVICON_HREF.slice('data:image/svg+xml,'.length))
    expect(decoded.replace(/'/g, '"')).toBe(FAVICON_SVG)
  })

  it('matches the copy in the dev and fallback shell', () => {
    // index.html cannot import a module, so the value is written twice. This is what stops the
    // two from drifting into a page whose icon changes depending on which path served it.
    const html = readFileSync(join(import.meta.dirname, '../../index.html'), 'utf8')
    expect(html).toContain(FAVICON_HREF)
  })
})
