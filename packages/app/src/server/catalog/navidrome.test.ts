import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { manifestSchema, runProjection } from '@neohomepage/catalog-schema'

/**
 * The one Navidrome shape the recorded fixture cannot hold: nothing playing. Subsonic answers
 * `"nowPlaying": {}` — an object where a list is expected — and the projection must read that as
 * an empty list rather than fail, because "nobody is listening" is the tile's usual state.
 */
const dir = join(import.meta.dirname, '../../../../../catalog/navidrome-playing')

describe('navidrome-playing', () => {
  it('projects an idle server as zero items, not an error', () => {
    const manifest = manifestSchema.parse(
      JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')),
    )
    if ('roles' in manifest) throw new Error('expected a single-target manifest')
    const idle = JSON.parse(readFileSync(join(dir, 'fixtures', 'idle.sample.json'), 'utf8'))
    const result = runProjection(manifest.projection, {
      source: idle,
      options: {},
      now: '2026-09-11T12:00:00.000Z',
    })
    expect(result).toEqual({
      ok: true,
      value: { stats: [{ label: 'Playing', value: 0 }], items: [] },
    })
  })
})
