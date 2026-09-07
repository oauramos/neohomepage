import type { Node, OpName } from './node.ts'

/**
 * The one place that knows the shape of every node. Depth checks, node counts, the opcode set a
 * manifest requires, and any future analysis all derive from this, so adding an operator without
 * teaching the walker about it is a type error rather than a silent gap in every check at once.
 */
export function children(node: Node): readonly Node[] {
  switch (node.op) {
    case 'get':
    case 'const':
    case 'now':
      return []
    case 'pick':
      return Object.values(node.fields)
    case 'map':
      return [node.over, node.body]
    case 'filter':
      return [node.over, node.where]
    case 'sort':
    case 'limit':
    case 'distinctBy':
      return [node.over]
    case 'concat':
    case 'coalesce':
    case 'and':
    case 'or':
    case 'arith':
      return node.of
    case 'lookup':
      return [node.over, node.in, node.body]
    case 'count':
    case 'sum':
    case 'avg':
    case 'min':
    case 'max':
    case 'first':
    case 'not':
    case 'clamp':
    case 'mapValue':
    case 'format':
      return [node.of]
    case 'if':
      return [node.cond, node.then, node.else]
    case 'compare':
      return [node.left, node.right]
    case 'in':
      return [node.needle, node.haystack]
    case 'targetUrl':
      return [node.path]
    default: {
      const exhaustive: never = node
      throw new Error(`children(): unhandled node ${JSON.stringify(exhaustive)}`)
    }
  }
}

/** Operators that introduce a loop, and so compose multiplicatively rather than additively. */
const LOOPING: ReadonlySet<OpName> = new Set<OpName>(['map', 'filter', 'lookup'])

export type Limits = {
  readonly maxDepth: number
  readonly maxNodes: number
  readonly maxLoopNesting: number
}

export const DEFAULT_LIMITS: Limits = { maxDepth: 12, maxNodes: 200, maxLoopNesting: 5 }

export class ProjectionTooComplexError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectionTooComplexError'
  }
}

export type Analysis = {
  readonly depth: number
  readonly nodes: number
  readonly loopNesting: number
  readonly opcodes: ReadonlySet<OpName>
}

/**
 * Static analysis, run once when a manifest is loaded rather than on every poll. This is what
 * makes the fuel budget at run time a backstop instead of the only defence: a manifest that could
 * blow the budget is refused at install time, where the user can be told which widget is at fault.
 */
export function analyse(root: Node, limits: Limits = DEFAULT_LIMITS): Analysis {
  let nodes = 0
  let maxDepth = 0
  let maxLoopNesting = 0
  const opcodes = new Set<OpName>()

  // Explicit stack: a recursive walker would blow the JS stack on a hostile deeply-nested tree
  // before our own depth check ever fired.
  const stack: { node: Node; depth: number; loops: number }[] = [{ node: root, depth: 1, loops: 0 }]

  while (stack.length > 0) {
    const frame = stack.pop() as { node: Node; depth: number; loops: number }
    nodes++
    opcodes.add(frame.node.op)
    if (frame.depth > maxDepth) maxDepth = frame.depth
    if (frame.loops > maxLoopNesting) maxLoopNesting = frame.loops

    if (nodes > limits.maxNodes) {
      throw new ProjectionTooComplexError(`projection has more than ${limits.maxNodes} nodes`)
    }
    if (frame.depth > limits.maxDepth) {
      throw new ProjectionTooComplexError(`projection nests deeper than ${limits.maxDepth}`)
    }
    if (frame.loops > limits.maxLoopNesting) {
      throw new ProjectionTooComplexError(
        `projection nests more than ${limits.maxLoopNesting} loops`,
      )
    }

    const nextLoops = frame.loops + (LOOPING.has(frame.node.op) ? 1 : 0)
    for (const child of children(frame.node)) {
      stack.push({ node: child, depth: frame.depth + 1, loops: nextLoops })
    }
  }

  return { depth: maxDepth, nodes, loopNesting: maxLoopNesting, opcodes }
}

/** The opcode set a manifest uses — derived, never trusted from the author's own `requires`. */
export function usedOpcodes(root: Node): ReadonlySet<OpName> {
  return analyse(root, { maxDepth: Infinity, maxNodes: Infinity, maxLoopNesting: Infinity }).opcodes
}
