import { isJsonArray, type Json, type JsonObject } from '../json.ts'
import type { Comparison, Node, SortKey } from './node.ts'
import {
  formatBitrate,
  formatBytes,
  formatDate,
  formatDuration,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  formatTemperature,
} from './format.ts'

/**
 * The interpreter.
 *
 * Two properties are load-bearing and every operator below preserves them:
 *
 *  TOTAL — no data shape produces an exception. A missing path, a string where a number was
 *  expected, a division by zero: all yield null. This is what makes "one broken widget degrades to
 *  a stale badge" true rather than aspirational, because a manifest cannot take the page down.
 *
 *  TERMINATING — no recursion, no user functions, no loops over anything but a finite array that
 *  has already been truncated. Static analysis rejects a too-complex tree at install time; the
 *  fuel budget here is the backstop for a tree that is cheap to describe and expensive to run.
 *
 * Limit violations do throw, deliberately, and only `runProjection` catches them — an exhausted
 * budget is a manifest bug worth surfacing, not a null to be silently rendered.
 */

export type EvalLimits = {
  /** Total node evaluations allowed. Guards a small tree over a large array. */
  readonly fuel: number
  /** Arrays longer than this are truncated before any loop sees them. */
  readonly maxArray: number
  /** Serialized size cap on the final value. */
  readonly maxOutputBytes: number
}

export const DEFAULT_EVAL_LIMITS: EvalLimits = {
  fuel: 200_000,
  maxArray: 5_000,
  maxOutputBytes: 16 * 1024,
}

export type EvalContext = {
  /** The decoded upstream response for this source. */
  readonly source: Json
  /** The widget instance's own configuration, reachable as `opt.*`. */
  readonly options: JsonObject
  /** Base URL of the bound target, for `targetUrl`. Absent means deep links are unavailable. */
  readonly targetBaseUrl?: string
  /** ISO instant. Injected rather than read from the clock so evaluation is deterministic. */
  readonly now: string
  readonly limits?: Partial<EvalLimits>
}

export class ProjectionLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectionLimitError'
  }
}

export type ProjectionResult =
  { readonly ok: true; readonly value: Json } | { readonly ok: false; readonly reason: string }

type Scope = ReadonlyMap<string, Json>

type Machine = {
  fuel: number
  readonly limits: EvalLimits
  readonly ctx: EvalContext
}

function truthy(value: Json): boolean {
  if (value === null || value === false) return false
  if (value === true) return true
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value)
  if (typeof value === 'string') return value.length > 0
  if (isJsonArray(value)) return value.length > 0
  return Object.keys(value).length > 0
}

function toNumber(value: Json): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  if (typeof value === 'boolean') return value ? 1 : 0
  return null
}

/** Walk a dotted path. Every failure is a null, never a throw. */
function walkPath(root: Json, segments: readonly string[]): Json {
  let current: Json = root
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return null
    if (isJsonArray(current)) {
      const index = Number(segment)
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return null
      current = current[index] as Json
    } else {
      if (!Object.hasOwn(current, segment)) return null
      current = current[segment] as Json
    }
  }
  return current
}

function resolvePath(scope: Scope, path: string): Json {
  const segments = path.split('.')
  const head = segments[0] as string
  if (!scope.has(head)) return null
  return walkPath(scope.get(head) as Json, segments.slice(1))
}

function asArray(machine: Machine, value: Json): readonly Json[] {
  if (!isJsonArray(value)) return []
  return value.length > machine.limits.maxArray ? value.slice(0, machine.limits.maxArray) : value
}

function bind(scope: Scope, name: string, value: Json): Scope {
  const next = new Map(scope)
  next.set(name, value)
  return next
}

function compareValues(cmp: Comparison, left: Json, right: Json): boolean {
  if (cmp === 'eq' || cmp === 'ne') {
    const equal =
      left === right ||
      (typeof left === 'object' &&
        typeof right === 'object' &&
        JSON.stringify(left) === JSON.stringify(right))
    return cmp === 'eq' ? equal : !equal
  }
  // Ordering only means something for two numbers or two strings. Anything else is false rather
  // than JavaScript's surprising coercions ([] < 1, null >= 0, and so on).
  if (typeof left === 'number' && typeof right === 'number') {
    return cmp === 'lt'
      ? left < right
      : cmp === 'lte'
        ? left <= right
        : cmp === 'gt'
          ? left > right
          : left >= right
  }
  if (typeof left === 'string' && typeof right === 'string') {
    const order = left.localeCompare(right, 'en-US')
    return cmp === 'lt'
      ? order < 0
      : cmp === 'lte'
        ? order <= 0
        : cmp === 'gt'
          ? order > 0
          : order >= 0
  }
  return false
}

function sortKeyValue(item: Json, key: SortKey): Json {
  return key.path === '$' ? item : walkPath(item, key.path.split('.'))
}

/**
 * Coerce a sort key to something orderable, or null when it cannot be ordered under this type.
 *
 * Collapsing "absent" and "unparseable" into one null is what keeps the direction flip honest: a
 * row with `airDate: "soon"` under a date sort is exactly as unknown as a row with no airDate, and
 * both must sink in ascending *and* descending order.
 */
function coerceSortKey(value: Json, type: NonNullable<SortKey['type']>): number | string | null {
  if (value === null || value === undefined) return null
  if (type === 'numeric') return toNumber(value)
  if (type === 'date') {
    const parsed = Date.parse(String(value))
    return Number.isNaN(parsed) ? null : parsed
  }
  if (typeof value === 'object') return null
  return String(value)
}

/**
 * Final ordering for one key, direction already applied.
 *
 * The caller must NOT flip the result: unorderable values sort last in BOTH directions. Flipping
 * the whole comparator would float every incomplete row to the top of a descending sort.
 */
function compareSorted(a: Json, b: Json, key: SortKey): number {
  const type = key.type ?? 'string'
  const left = coerceSortKey(a, type)
  const right = coerceSortKey(b, type)

  if (left === null && right === null) return 0
  if (left === null) return 1
  if (right === null) return -1

  const order =
    typeof left === 'number' && typeof right === 'number'
      ? left - right
      : String(left).localeCompare(String(right), 'en-US')
  return key.dir === 'desc' ? -order : order
}

function evaluate(node: Node, scope: Scope, machine: Machine): Json {
  if (--machine.fuel < 0) {
    throw new ProjectionLimitError('projection exhausted its evaluation budget')
  }

  switch (node.op) {
    case 'get':
      return node.path === '$' ? ((scope.get('$') as Json) ?? null) : resolvePath(scope, node.path)

    case 'const':
      return node.value as Json

    case 'now':
      return machine.ctx.now

    case 'pick': {
      const out: Record<string, Json> = {}
      for (const [key, child] of Object.entries(node.fields)) {
        out[key] = evaluate(child, scope, machine)
      }
      return out
    }

    case 'map': {
      const items = asArray(machine, evaluate(node.over, scope, machine))
      return items.map((item) => evaluate(node.body, bind(scope, node.as, item), machine))
    }

    case 'filter': {
      const items = asArray(machine, evaluate(node.over, scope, machine))
      return items.filter((item) =>
        truthy(evaluate(node.where, bind(scope, node.as, item), machine)),
      )
    }

    case 'sort': {
      const items = [...asArray(machine, evaluate(node.over, scope, machine))]
      return items.sort((a, b) => {
        for (const key of node.by) {
          const order = compareSorted(sortKeyValue(a, key), sortKeyValue(b, key), key)
          if (order !== 0) return order
        }
        return 0
      })
    }

    case 'limit':
      return asArray(machine, evaluate(node.over, scope, machine)).slice(0, node.n)

    case 'distinctBy': {
      const items = asArray(machine, evaluate(node.over, scope, machine))
      const seen = new Set<string>()
      const out: Json[] = []
      for (const item of items) {
        const key = JSON.stringify(walkPath(item, node.by.split('.')) ?? null)
        if (seen.has(key)) continue
        seen.add(key)
        out.push(item)
      }
      return out
    }

    case 'concat': {
      const out: Json[] = []
      for (const child of node.of) {
        const value = evaluate(child, scope, machine)
        if (isJsonArray(value)) out.push(...value)
        else if (value !== null) out.push(value)
        if (out.length > machine.limits.maxArray) return out.slice(0, machine.limits.maxArray)
      }
      return out
    }

    case 'lookup': {
      const left = asArray(machine, evaluate(node.over, scope, machine))
      const right = asArray(machine, evaluate(node.in, scope, machine))
      // Hash join rather than a nested scan: sonarr joins a queue against a series list, and the
      // quadratic version is what makes a 500-episode library melt a Pi.
      const index = new Map<string, Json>()
      for (const row of right) {
        const key = JSON.stringify(walkPath(row, node.onRight.split('.')) ?? null)
        if (!index.has(key)) index.set(key, row)
      }
      return left.map((item) => {
        const key = JSON.stringify(walkPath(item, node.onLeft.split('.')) ?? null)
        const matched = index.get(key) ?? null
        return evaluate(node.body, bind(bind(scope, node.as, item), node.bind, matched), machine)
      })
    }

    case 'count':
      return asArray(machine, evaluate(node.of, scope, machine)).length

    case 'sum':
    case 'avg':
    case 'min':
    case 'max': {
      const items = asArray(machine, evaluate(node.of, scope, machine))
      const numbers: number[] = []
      for (const item of items) {
        const raw = node.path === undefined ? item : walkPath(item, node.path.split('.'))
        const value = toNumber(raw)
        if (value !== null) numbers.push(value)
      }
      if (numbers.length === 0) return node.op === 'sum' ? 0 : null
      if (node.op === 'sum') return numbers.reduce((a, b) => a + b, 0)
      if (node.op === 'avg') return numbers.reduce((a, b) => a + b, 0) / numbers.length
      return node.op === 'min' ? Math.min(...numbers) : Math.max(...numbers)
    }

    case 'first': {
      const items = asArray(machine, evaluate(node.of, scope, machine))
      return items.length === 0 ? null : (items[0] as Json)
    }

    case 'if':
      return truthy(evaluate(node.cond, scope, machine))
        ? evaluate(node.then, scope, machine)
        : evaluate(node.else, scope, machine)

    case 'coalesce': {
      for (const child of node.of) {
        const value = evaluate(child, scope, machine)
        if (value !== null) return value
      }
      return null
    }

    case 'and': {
      for (const child of node.of) if (!truthy(evaluate(child, scope, machine))) return false
      return true
    }

    case 'or': {
      for (const child of node.of) if (truthy(evaluate(child, scope, machine))) return true
      return false
    }

    case 'not':
      return !truthy(evaluate(node.of, scope, machine))

    case 'compare':
      return compareValues(
        node.cmp,
        evaluate(node.left, scope, machine),
        evaluate(node.right, scope, machine),
      )

    case 'in': {
      const needle = evaluate(node.needle, scope, machine)
      const haystack = evaluate(node.haystack, scope, machine)
      if (isJsonArray(haystack)) return haystack.some((entry) => compareValues('eq', entry, needle))
      if (typeof haystack === 'string' && typeof needle === 'string')
        return haystack.includes(needle)
      return false
    }

    case 'arith': {
      const numbers = node.of.map((child) => toNumber(evaluate(child, scope, machine)))
      if (numbers.some((value) => value === null)) return null
      const values = numbers as number[]
      switch (node.fn) {
        case 'add':
          return values.reduce((a, b) => a + b, 0)
        case 'mul':
          return values.reduce((a, b) => a * b, 1)
        case 'sub':
          return values.slice(1).reduce((a, b) => a - b, values[0] as number)
        case 'div': {
          let acc = values[0] as number
          for (const value of values.slice(1)) {
            if (value === 0) return null
            acc /= value
          }
          return Number.isFinite(acc) ? acc : null
        }
      }
      return null
    }

    case 'clamp': {
      const value = toNumber(evaluate(node.of, scope, machine))
      if (value === null) return null
      return Math.min(node.max, Math.max(node.min, value))
    }

    case 'mapValue': {
      const value = evaluate(node.of, scope, machine)
      const key = value === null ? 'null' : String(value)
      if (Object.hasOwn(node.cases, key)) return node.cases[key] as Json
      return (node.fallback as Json) ?? null
    }

    case 'targetUrl': {
      const suffix = evaluate(node.path, scope, machine)
      if (typeof suffix !== 'string' || machine.ctx.targetBaseUrl === undefined) return null
      // The manifest names a path, never a host. The base comes from the target the user bound,
      // so a catalog entry cannot point a deep link at somewhere else.
      const base = machine.ctx.targetBaseUrl.replace(/\/+$/, '')
      const path = suffix.startsWith('/') ? suffix : `/${suffix}`
      if (path.includes('..') || path.includes('//')) return null
      return `${base}${path}`
    }

    case 'format': {
      const value = evaluate(node.of, scope, machine)
      switch (node.as) {
        case 'bytes':
          return formatBytes(value)
        case 'bitrate':
          return formatBitrate(value)
        case 'duration':
          return formatDuration(value)
        case 'percent':
          return formatPercent(value)
        case 'number':
          return formatNumber(value)
        case 'temperature':
          return formatTemperature(value)
        case 'date':
          return formatDate(value)
        case 'relativeTime':
          return formatRelativeTime(value, machine.ctx.now)
      }
      return null
    }

    default: {
      const exhaustive: never = node
      throw new Error(`evaluate(): unhandled node ${JSON.stringify(exhaustive)}`)
    }
  }
}

/** The only entry point. Nothing above this line escapes as an exception. */
export function runProjection(node: Node, ctx: EvalContext): ProjectionResult {
  const limits = { ...DEFAULT_EVAL_LIMITS, ...ctx.limits }
  const machine: Machine = { fuel: limits.fuel, limits, ctx }
  const scope: Scope = new Map<string, Json>([
    ['$', ctx.source],
    ['opt', ctx.options],
  ])

  try {
    const value = evaluate(node, scope, machine)
    const serialized = JSON.stringify(value)
    if (serialized !== undefined && serialized.length > limits.maxOutputBytes) {
      return {
        ok: false,
        reason: `projection produced ${serialized.length} bytes, over the ${limits.maxOutputBytes} byte cap`,
      }
    }
    return { ok: true, value }
  } catch (error) {
    if (error instanceof ProjectionLimitError) return { ok: false, reason: error.message }
    // An unexpected throw is a bug in the interpreter, not in the data. Surface it as a failed
    // projection so one widget degrades instead of the whole page, but keep the message.
    return {
      ok: false,
      reason: `projection failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
