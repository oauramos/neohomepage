import { describe, expect, it } from 'vitest'
import { nodeSchema, OP_NAMES, type Node } from './node.ts'
import { analyse, children, ProjectionTooComplexError, usedOpcodes } from './walk.ts'

const get = (path: string): Node => ({ op: 'get', path })
const lit = (v: unknown): Node => ({ op: 'const', value: v })

/** One valid example per operator. Doubles as the exhaustiveness fixture below. */
const EXAMPLES: Record<(typeof OP_NAMES)[number], Node> = {
  get: get('$.a'),
  const: lit(1),
  now: { op: 'now' },
  pick: { op: 'pick', fields: { a: lit(1) } },
  map: { op: 'map', over: get('$'), as: 'e', body: get('e.x') },
  filter: { op: 'filter', over: get('$'), as: 'e', where: get('e.x') },
  sort: { op: 'sort', over: get('$'), by: [{ path: 'x' }] },
  limit: { op: 'limit', over: get('$'), n: 5 },
  distinctBy: { op: 'distinctBy', over: get('$'), by: 'id' },
  concat: { op: 'concat', of: [get('$.a')] },
  lookup: {
    op: 'lookup',
    over: get('$.a'),
    as: 'l',
    in: get('$.b'),
    onLeft: 'id',
    onRight: 'id',
    bind: 'r',
    body: get('r.x'),
  },
  count: { op: 'count', of: get('$') },
  sum: { op: 'sum', of: get('$'), path: 'x' },
  avg: { op: 'avg', of: get('$') },
  min: { op: 'min', of: get('$') },
  max: { op: 'max', of: get('$') },
  first: { op: 'first', of: get('$') },
  if: { op: 'if', cond: lit(true), then: lit(1), else: lit(2) },
  coalesce: { op: 'coalesce', of: [get('$.a'), lit(0)] },
  and: { op: 'and', of: [lit(true)] },
  or: { op: 'or', of: [lit(true)] },
  not: { op: 'not', of: lit(false) },
  compare: { op: 'compare', cmp: 'eq', left: lit(1), right: lit(1) },
  in: { op: 'in', needle: lit('a'), haystack: lit(['a']) },
  arith: { op: 'arith', fn: 'add', of: [lit(1), lit(2)] },
  clamp: { op: 'clamp', of: lit(5), min: 0, max: 1 },
  mapValue: { op: 'mapValue', of: get('$.s'), cases: { a: 1 } },
  targetUrl: { op: 'targetUrl', path: lit('/x') },
  format: { op: 'format', of: lit(1), as: 'bytes' },
}

describe('the operator set is closed and fully covered', () => {
  it('has an example for every operator, and no example for a non-operator', () => {
    // If someone adds an operator to the union without adding it here, this fails — which is the
    // point: the walker, the schema and the docs all key off OP_NAMES.
    expect(Object.keys(EXAMPLES).sort()).toEqual([...OP_NAMES].sort())
  })

  it('parses every operator through the schema', () => {
    for (const [name, node] of Object.entries(EXAMPLES)) {
      const parsed = nodeSchema.safeParse(node)
      expect(
        parsed.success,
        `${name}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`,
      ).toBe(true)
    }
  })

  it('knows the children of every operator', () => {
    for (const node of Object.values(EXAMPLES)) {
      expect(() => children(node)).not.toThrow()
    }
  })
})

describe('schema rejection', () => {
  it('refuses an unknown operator instead of ignoring it', () => {
    expect(nodeSchema.safeParse({ op: 'exec', cmd: 'rm -rf /' }).success).toBe(false)
    expect(nodeSchema.safeParse({ op: 'eval', of: { op: 'const', value: 1 } }).success).toBe(false)
  })

  it('refuses a path that is not a plain dotted walk', () => {
    for (const path of ['a[*]', 'a..b', '../x', 'a b', "a'", '$$$', '']) {
      expect(nodeSchema.safeParse({ op: 'get', path }).success, path).toBe(false)
    }
  })

  it('refuses a binding name that could shadow a scope root', () => {
    expect(nodeSchema.safeParse({ ...EXAMPLES.map, as: '$' }).success).toBe(false)
    expect(nodeSchema.safeParse({ ...EXAMPLES.map, as: 'Opt' }).success).toBe(false)
  })

  it('caps limit and sort key counts at the schema, not at run time', () => {
    expect(nodeSchema.safeParse({ op: 'limit', over: get('$'), n: 10_000 }).success).toBe(false)
    expect(
      nodeSchema.safeParse({
        op: 'sort',
        over: get('$'),
        by: [{ path: 'a' }, { path: 'b' }, { path: 'c' }, { path: 'd' }, { path: 'e' }],
      }).success,
    ).toBe(false)
  })
})

describe('static analysis', () => {
  function nest(depth: number): Node {
    let node: Node = get('$')
    for (let i = 0; i < depth; i++) node = { op: 'not', of: node }
    return node
  }

  it('measures depth, node count and loop nesting', () => {
    const result = analyse(EXAMPLES.lookup)
    expect(result.nodes).toBe(4)
    expect(result.loopNesting).toBe(1)
    expect([...result.opcodes].sort()).toEqual(['get', 'lookup'])
  })

  it('refuses a tree deeper than the limit', () => {
    expect(() => analyse(nest(20))).toThrow(ProjectionTooComplexError)
    expect(() => analyse(nest(3))).not.toThrow()
  })

  it('refuses a tree with too many nodes', () => {
    const wide: Node = { op: 'and', of: Array.from({ length: 16 }, () => EXAMPLES.lookup) }
    expect(() => analyse(wide, { maxDepth: 100, maxNodes: 10, maxLoopNesting: 100 })).toThrow(
      ProjectionTooComplexError,
    )
  })

  it('refuses loops nested past the limit, which is what bounds the real cost', () => {
    let node: Node = get('$')
    for (let i = 0; i < 6; i++) node = { op: 'map', over: get('$'), as: 'e', body: node }
    expect(() => analyse(node, { maxDepth: 100, maxNodes: 1000, maxLoopNesting: 5 })).toThrow(
      /nests more than 5 loops/,
    )
  })

  it('survives a hostile deep tree without blowing the JS stack', () => {
    // A recursive walker would throw RangeError here before our own limit ever fired.
    expect(() => analyse(nest(50_000))).toThrow(ProjectionTooComplexError)
  })

  it('derives the opcode set a manifest requires, ignoring the caps', () => {
    const node: Node = {
      op: 'format',
      of: { op: 'sum', of: { op: 'map', over: get('$'), as: 'e', body: get('e.size') } },
      as: 'bytes',
    }
    expect([...usedOpcodes(node)].sort()).toEqual(['format', 'get', 'map', 'sum'])
  })
})
