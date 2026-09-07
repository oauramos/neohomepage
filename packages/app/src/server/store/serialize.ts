import type { z } from 'zod'

/**
 * Deterministic JSON serialisation.
 *
 * The config directory is meant to live in git, so the diff of a one-field change must be one
 * line. Three rules get us there, and all three are enforced by tests rather than by habit:
 * keys come out in the schema's declaration order (then alphabetically for anything the schema
 * does not know about), every value equal to its schema default is dropped, and the file always
 * ends with a single LF.
 */

export type SerializeOptions = {
  /** Key order to prefer, normally the schema's declaration order. */
  readonly keyOrder?: readonly string[]
  /** Values matching these are omitted, keeping files sparse and diffs meaningful. */
  readonly defaults?: Readonly<Record<string, unknown>>
}

/**
 * JavaScript pins integer-like object keys to the front, in ascending numeric order, even after
 * an explicit sort. A "deterministic" serialiser that ignores this silently is not one, so a
 * numeric-like key anywhere in the tree is refused rather than quietly reordered. Config uses
 * arrays of `{id, ...}` or prefixed ids instead.
 */
export class NumericKeyError extends Error {
  constructor(path: string, key: string) {
    super(
      `numeric-like object key ${JSON.stringify(key)} at ${path}: JavaScript reorders these ` +
        'regardless of sorting, so the serialisation would not be deterministic. Use an array ' +
        'of objects with an id, or prefix the key.',
    )
    this.name = 'NumericKeyError'
  }
}

const NUMERIC_LIKE = /^(0|[1-9]\d*)$/

function orderKeys(keys: readonly string[], preferred: readonly string[]): string[] {
  const rank = new Map(preferred.map((key, index) => [key, index]))
  return [...keys].sort((a, b) => {
    const ra = rank.get(a)
    const rb = rank.get(b)
    if (ra !== undefined && rb !== undefined) return ra - rb
    if (ra !== undefined) return -1
    if (rb !== undefined) return 1
    return a.localeCompare(b, 'en-US')
  })
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalise(a, '', [])) === JSON.stringify(normalise(b, '', []))
}

function normalise(value: unknown, path: string, preferred: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map((entry, i) => normalise(entry, `${path}[${i}]`, []))
  if (value === null || typeof value !== 'object') return value

  const record = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of orderKeys(Object.keys(record), preferred)) {
    if (NUMERIC_LIKE.test(key)) throw new NumericKeyError(path === '' ? '(root)' : path, key)
    const child = record[key]
    if (child === undefined) continue
    out[key] = normalise(child, path === '' ? key : `${path}.${key}`, [])
  }
  return out
}

function dropDefaults(
  value: Record<string, unknown>,
  defaults: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (Object.hasOwn(defaults, key) && deepEqual(child, defaults[key])) continue
    out[key] = child
  }
  return out
}

export function serialize(value: unknown, options: SerializeOptions = {}): string {
  let subject = value
  if (
    options.defaults !== undefined &&
    subject !== null &&
    typeof subject === 'object' &&
    !Array.isArray(subject)
  ) {
    subject = dropDefaults(subject as Record<string, unknown>, options.defaults)
  }
  const ordered = normalise(subject, '', options.keyOrder ?? [])
  return `${JSON.stringify(ordered, null, 2)}\n`
}

/** Declaration order of a Zod object's keys, so serialisation follows the schema, not the author. */
export function schemaKeyOrder(schema: z.ZodObject): readonly string[] {
  return Object.keys(schema.shape)
}

/**
 * Defaults a Zod object declares, for the drop-defaults pass.
 *
 * Parsing `{}` would only work for a schema with no required fields, which no real config file
 * has. Each field is probed with `undefined` instead: that succeeds exactly when the field
 * supplies a default, and it does not depend on Zod's internal representation.
 */
export function schemaDefaults(schema: z.ZodObject): Record<string, unknown> {
  const defaults: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(schema.shape)) {
    const probed = (field as z.ZodType).safeParse(undefined)
    if (probed.success && probed.data !== undefined) defaults[key] = probed.data
  }
  return defaults
}
