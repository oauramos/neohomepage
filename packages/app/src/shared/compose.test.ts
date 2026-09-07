import { describe, expect, it } from 'vitest'
import { composeSchema, type Compose } from '@neohomepage/catalog-schema'
import { composeSources, type SourcePart } from './compose.ts'

const compose = (overrides: Partial<Compose> = {}): Compose => composeSchema.parse({ ...overrides })

const part = (overrides: Partial<SourcePart> = {}): SourcePart => ({
  key: 'k',
  pending: false,
  ok: true,
  items: [],
  fetchedAt: '2026-09-06T12:00:00.000Z',
  ageMs: 1000,
  state: 'fresh',
  errorCode: null,
  ...overrides,
})

const at = (iso: string, title: string) => ({ title, badge: { v: title, iso, rel: true as const } })

describe('merging', () => {
  it('concatenates every answering source', () => {
    const composed = composeSources(compose(), [
      part({ key: 'a', items: [{ title: 'one' }] }),
      part({ key: 'b', items: [{ title: 'two' }] }),
    ])
    expect(composed.projection?.items?.map((i) => i.title)).toEqual(['one', 'two'])
    expect(composed.sources).toEqual({ total: 2, ok: 2 })
  })

  it('sorts by a nested path, which is how a calendar orders by instant', () => {
    const composed = composeSources(
      compose({ sortBy: [{ path: 'badge.iso', direction: 'asc' }] }),
      [
        part({ key: 'a', items: [at('2026-09-08T00:00:00.000Z', 'later')] }),
        part({ key: 'b', items: [at('2026-09-07T00:00:00.000Z', 'sooner')] }),
      ],
    )
    expect(composed.projection?.items?.map((i) => i.title)).toEqual(['sooner', 'later'])
  })

  it('keeps items with no sort key at the bottom in BOTH directions', () => {
    // The direction flip is applied to the comparator's result, so a naive implementation floats
    // everything unsortable to the top under `desc`.
    const items = [{ title: 'no key' }, at('2026-09-07T00:00:00.000Z', 'dated')]
    for (const direction of ['asc', 'desc'] as const) {
      const composed = composeSources(compose({ sortBy: [{ path: 'badge.iso', direction }] }), [
        part({ items }),
      ])
      expect(composed.projection?.items?.at(-1)?.title, direction).toBe('no key')
    }
  })

  it('falls through to the second sort key on a tie', () => {
    const composed = composeSources(
      compose({
        sortBy: [
          { path: 'badge.iso', direction: 'asc' },
          { path: 'title', direction: 'asc' },
        ],
      }),
      [
        part({
          items: [at('2026-09-07T00:00:00.000Z', 'b'), at('2026-09-07T00:00:00.000Z', 'a')],
        }),
      ],
    )
    expect(composed.projection?.items?.map((i) => i.title)).toEqual(['a', 'b'])
  })

  it('drops duplicates by a chosen key, keeping the first', () => {
    // Two *arr instances that both track the same show would otherwise show every episode twice.
    const composed = composeSources(compose({ distinctBy: 'title' }), [
      part({ key: 'a', items: [{ title: 'S02E03', subtitle: 'from sonarr-a' }] }),
      part({ key: 'b', items: [{ title: 'S02E03', subtitle: 'from sonarr-b' }] }),
    ])
    expect(composed.projection?.items).toEqual([{ title: 'S02E03', subtitle: 'from sonarr-a' }])
  })

  it('never treats two missing keys as duplicates of each other', () => {
    const composed = composeSources(compose({ distinctBy: 'href' }), [
      part({ items: [{ title: 'one' }, { title: 'two' }] }),
    ])
    expect(composed.projection?.items).toHaveLength(2)
  })

  it('truncates to the limit after sorting, not before', () => {
    const composed = composeSources(
      compose({ limit: 2, sortBy: [{ path: 'badge.iso', direction: 'asc' }] }),
      [
        part({ key: 'a', items: [at('2026-09-09T00:00:00.000Z', 'third')] }),
        part({ key: 'b', items: [at('2026-09-07T00:00:00.000Z', 'first')] }),
        part({ key: 'c', items: [at('2026-09-08T00:00:00.000Z', 'second')] }),
      ],
    )
    expect(composed.projection?.items?.map((i) => i.title)).toEqual(['first', 'second'])
  })
})

describe('partial failure', () => {
  it('renders the sources that answered and reports degraded', () => {
    const composed = composeSources(compose(), [
      part({ key: 'a', items: [{ title: 'from the live one' }] }),
      part({ key: 'b', ok: false, state: 'error', errorCode: 'unreachable' }),
    ])
    expect(composed.projection?.items).toHaveLength(1)
    expect(composed.projection?.status).toBe('degraded')
    expect(composed.meta.errorCode).toBe('partial')
    expect(composed.sources).toEqual({ total: 2, ok: 1 })
  })

  it('refuses to render a partial answer when the manifest says not to', () => {
    const composed = composeSources(compose({ partial: false }), [
      part({ key: 'a', items: [{ title: 'half the roster' }] }),
      part({ key: 'b', ok: false, state: 'error', errorCode: 'http-503' }),
    ])
    expect(composed.projection).toBeNull()
    expect(composed.meta).toMatchObject({ state: 'error', errorCode: 'http-503' })
  })

  it('reports the first error when every source is down', () => {
    const composed = composeSources(compose(), [
      part({ ok: false, state: 'error', errorCode: 'missing-credential' }),
      part({ ok: false, state: 'error', errorCode: 'unreachable' }),
    ])
    expect(composed.projection).toBeNull()
    expect(composed.meta.errorCode).toBe('missing-credential')
  })

  it('distinguishes "not fetched yet" from "down"', () => {
    // Otherwise every composite accuses its services of being down for the first few seconds
    // after a restart, and people learn to ignore the badge.
    const composed = composeSources(compose(), [part({ pending: true, ok: false, state: 'error' })])
    expect(composed.meta.errorCode).toBe('pending')
    expect(composed.sources).toEqual({ total: 1, ok: 0 })
  })

  it('does not count a pending source as a failure once another has answered', () => {
    const composed = composeSources(compose(), [
      part({ key: 'a', items: [{ title: 'ready' }] }),
      part({ key: 'b', pending: true, ok: false, state: 'error' }),
    ])
    expect(composed.projection?.status).toBe('ok')
    expect(composed.meta.errorCode).toBeUndefined()
  })

  it('has no sources at all', () => {
    const composed = composeSources(compose(), [])
    expect(composed.projection).toBeNull()
    expect(composed.meta.errorCode).toBe('no-sources')
  })
})

describe('freshness', () => {
  it('reports the age of the STALEST answering source', () => {
    // A widget is only as fresh as its oldest part; reporting the newest would let one lively
    // source hide four that stopped updating an hour ago.
    const composed = composeSources(compose(), [
      part({ key: 'a', ageMs: 1_000, items: [{ title: 'a' }] }),
      part({ key: 'b', ageMs: 600_000, items: [{ title: 'b' }] }),
    ])
    expect(composed.meta.ageMs).toBe(600_000)
  })

  it('is stale when any answering source is stale', () => {
    const composed = composeSources(compose(), [
      part({ key: 'a', items: [{ title: 'a' }] }),
      part({ key: 'b', state: 'stale', items: [{ title: 'b' }] }),
    ])
    expect(composed.meta.state).toBe('stale')
  })
})
