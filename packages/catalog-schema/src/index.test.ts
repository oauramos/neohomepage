import { describe, expect, it } from 'vitest'
import { SUPPORTED_MANIFEST_VERSIONS } from './index.ts'

describe('manifest compatibility', () => {
  it('declares the manifest versions this build accepts', () => {
    // A manifest outside this list must be refused at install time, not discovered at render
    // time as a widget that installs and then shows nothing.
    expect(SUPPORTED_MANIFEST_VERSIONS).toContain(1)
    expect(SUPPORTED_MANIFEST_VERSIONS.length).toBeGreaterThan(0)
  })
})
