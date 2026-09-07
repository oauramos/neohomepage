import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { NumericKeyError, schemaDefaults, schemaKeyOrder, serialize } from './serialize.ts'

describe('key ordering', () => {
  it('follows the schema declaration order, then alphabetical for the rest', () => {
    const out = serialize(
      { zeta: 1, id: 'a', unknownB: 2, title: 't', unknownA: 3 },
      { keyOrder: ['id', 'title'] },
    )
    expect(Object.keys(JSON.parse(out))).toEqual(['id', 'title', 'unknownA', 'unknownB', 'zeta'])
  })

  it('produces byte-identical output regardless of insertion order', () => {
    const a = serialize({ b: 1, a: 2, c: { y: 1, x: 2 } })
    const b = serialize({ c: { x: 2, y: 1 }, a: 2, b: 1 })
    expect(a).toBe(b)
  })

  it('refuses numeric-like keys instead of silently reordering them', () => {
    // JS pins integer-like keys to the front in ascending order, whatever you sort. A serialiser
    // that ignores this is not deterministic, and the failure is invisible in review.
    expect(() => serialize({ '2': 'b', '1': 'a' })).toThrow(NumericKeyError)
    expect(() => serialize({ widgets: { '10': {} } })).toThrow(NumericKeyError)
    // Prefixed ids are the supported alternative, and must keep working.
    expect(() => serialize({ widgets: { w10: {}, w2: {} } })).not.toThrow()
  })

  it('names the path of an offending key so the fix is obvious', () => {
    expect(() => serialize({ pages: { home: { items: { '0': 1 } } } })).toThrow(
      /pages\.home\.items/,
    )
  })
})

describe('dropping defaults', () => {
  it('omits values equal to the schema default, which is what keeps diffs one line', () => {
    const defaults = { hideEmpty: false, maxItems: 5 }
    const out = JSON.parse(serialize({ id: 'w1', hideEmpty: false, maxItems: 9 }, { defaults }))
    expect(out).toEqual({ id: 'w1', maxItems: 9 })
  })

  it('compares structurally, not by reference', () => {
    const defaults = { margin: [12, 12] }
    expect(JSON.parse(serialize({ margin: [12, 12] }, { defaults }))).toEqual({})
    expect(JSON.parse(serialize({ margin: [12, 8] }, { defaults }))).toEqual({ margin: [12, 8] })
  })

  it('only drops at the top level, so a nested field that matches a default survives', () => {
    // Dropping recursively would delete a deliberate `{ poll: { intervalMs: 60000 } }` just
    // because it matches the manifest default, and the user would lose it on the next write.
    const out = JSON.parse(
      serialize({ poll: { intervalMs: 60000 } }, { defaults: { intervalMs: 60000 } }),
    )
    expect(out).toEqual({ poll: { intervalMs: 60000 } })
  })
})

describe('file shape', () => {
  it('is two-space indented and ends with exactly one newline', () => {
    const out = serialize({ a: { b: 1 } })
    expect(out).toBe('{\n  "a": {\n    "b": 1\n  }\n}\n')
    expect(out.endsWith('}\n')).toBe(true)
    expect(out.endsWith('}\n\n')).toBe(false)
  })

  it('drops undefined rather than emitting null for it', () => {
    expect(JSON.parse(serialize({ a: 1, b: undefined }))).toEqual({ a: 1 })
  })

  it('preserves array order, which is meaningful for layouts', () => {
    expect(JSON.parse(serialize({ items: [3, 1, 2] }))).toEqual({ items: [3, 1, 2] })
  })
})

describe('schema introspection', () => {
  const schema = z.object({
    id: z.string(),
    title: z.string().default('Home'),
    columns: z.number().default(12),
  })

  it('reads declaration order from the schema, not from an author-maintained list', () => {
    expect(schemaKeyOrder(schema)).toEqual(['id', 'title', 'columns'])
  })

  it('reads the defaults the schema declares', () => {
    expect(schemaDefaults(schema)).toEqual({ title: 'Home', columns: 12 })
  })

  it('round-trips: serialising a fully-default object leaves only the required fields', () => {
    const out = JSON.parse(
      serialize(
        { id: 'home', title: 'Home', columns: 12 },
        {
          keyOrder: schemaKeyOrder(schema),
          defaults: schemaDefaults(schema),
        },
      ),
    )
    expect(out).toEqual({ id: 'home' })
  })
})

describe('recursive schema ordering', () => {
  const layoutItem = z.object({ i: z.string(), x: z.number(), y: z.number(), w: z.number(), h: z.number() })
  const file = z.object({
    page: z.string(),
    layouts: z.record(z.string(), z.array(layoutItem)),
    meta: z.record(z.string(), z.object({ origin: z.string(), cols: z.number() })),
  })

  it('orders nested array items by their own schema, not alphabetically', () => {
    // Alphabetical would give `h, i, w, x, y`, which is deterministic but unreadable in a diff.
    const out = serialize(
      { page: 'home', layouts: { lg: [{ h: 3, i: 'w1', w: 4, x: 0, y: 0 }] }, meta: {} },
      { schema: file },
    )
    const item = out.slice(out.indexOf('['), out.indexOf(']'))
    expect(item.indexOf('"i"')).toBeLessThan(item.indexOf('"x"'))
    expect(item.indexOf('"x"')).toBeLessThan(item.indexOf('"y"'))
    expect(item.indexOf('"y"')).toBeLessThan(item.indexOf('"w"'))
    expect(item.indexOf('"w"')).toBeLessThan(item.indexOf('"h"'))
  })

  it('orders values inside a record by the record value schema', () => {
    const out = serialize({ page: 'home', layouts: {}, meta: { lg: { cols: 12, origin: 'authored' } } }, { schema: file })
    const meta = out.slice(out.indexOf('"meta"'))
    expect(meta.indexOf('"origin"')).toBeLessThan(meta.indexOf('"cols"'))
  })

  it('orders nested objects reached through optional and default wrappers', () => {
    const schema = z.object({
      grid: z.object({ rowHeight: z.number(), margin: z.array(z.number()) }).prefault({ rowHeight: 56, margin: [] }),
    })
    const out = serialize({ grid: { margin: [1, 2], rowHeight: 40 } }, { schema })
    expect(out.indexOf('"rowHeight"')).toBeLessThan(out.indexOf('"margin"'))
  })

  it('still sorts keys the schema does not name, so unknown fields stay deterministic', () => {
    const schema = z.object({ id: z.string() }).catchall(z.unknown())
    const out = JSON.parse(serialize({ zeta: 1, id: 'a', alpha: 2 }, { schema }))
    expect(Object.keys(out)).toEqual(['id', 'alpha', 'zeta'])
  })
})
