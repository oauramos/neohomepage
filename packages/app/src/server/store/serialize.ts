import { z } from 'zod'

/**
 * Deterministic JSON serialisation for config files kept in git: keys in schema declaration order
 * (recursively), values equal to their schema default dropped, exactly one trailing LF.
 */

export type SerializeOptions = {
  /** Order and defaults are both read from here when present. */
  readonly schema?: z.ZodType
  /** Fallback ordering for a value with no schema. */
  readonly keyOrder?: readonly string[]
  /** Top-level values equal to these are omitted. */
  readonly defaults?: Readonly<Record<string, unknown>>
}

/**
 * JavaScript orders integer-like object keys first, ascending, regardless of sorting, so such a
 * key anywhere in the tree is refused; config uses arrays of `{id, ...}` or prefixed ids instead.
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

/** Peel optional/nullable/default/prefault/catch wrappers to reach the schema that has a shape. */
function unwrap(schema: z.ZodType | undefined): z.ZodType | undefined {
  let current = schema
  for (let depth = 0; depth < 10 && current !== undefined; depth++) {
    if (
      current instanceof z.ZodOptional ||
      current instanceof z.ZodNullable ||
      current instanceof z.ZodDefault ||
      current instanceof z.ZodPrefault ||
      current instanceof z.ZodCatch
    ) {
      current = current.unwrap() as z.ZodType
      continue
    }
    return current
  }
  return current
}

function fieldSchemas(schema: z.ZodType | undefined): Record<string, z.ZodType> | undefined {
  const inner = unwrap(schema)
  if (inner instanceof z.ZodObject) return inner.shape as Record<string, z.ZodType>
  return undefined
}

function elementSchema(schema: z.ZodType | undefined): z.ZodType | undefined {
  const inner = unwrap(schema)
  if (inner instanceof z.ZodArray) return inner.element as z.ZodType
  if (inner instanceof z.ZodRecord) return inner.valueType as z.ZodType
  return undefined
}

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

function normalise(
  value: unknown,
  path: string,
  schema: z.ZodType | undefined,
  preferred: readonly string[],
): unknown {
  if (Array.isArray(value)) {
    const element = elementSchema(schema)
    return value.map((entry, i) => normalise(entry, `${path}[${i}]`, element, []))
  }
  if (value === null || typeof value !== 'object') return value

  const record = value as Record<string, unknown>
  const shape = fieldSchemas(schema)
  const order = shape !== undefined ? Object.keys(shape) : preferred
  const out: Record<string, unknown> = {}

  for (const key of orderKeys(Object.keys(record), order)) {
    if (NUMERIC_LIKE.test(key)) throw new NumericKeyError(path === '' ? '(root)' : path, key)
    const child = record[key]
    if (child === undefined) continue
    // Keys the schema does not name (record entries, newer fields) still order via the record's value schema.
    const childSchema = shape?.[key] ?? elementSchema(schema)
    out[key] = normalise(child, path === '' ? key : `${path}.${key}`, childSchema, [])
  }
  return out
}

function deepEqual(a: unknown, b: unknown): boolean {
  return (
    JSON.stringify(normalise(a, '', undefined, [])) ===
    JSON.stringify(normalise(b, '', undefined, []))
  )
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
  const schema = options.schema
  const objectSchema = unwrap(schema)
  const defaults =
    options.defaults ??
    (objectSchema instanceof z.ZodObject ? schemaDefaults(objectSchema) : undefined)

  let subject = value
  if (
    defaults !== undefined &&
    subject !== null &&
    typeof subject === 'object' &&
    !Array.isArray(subject)
  ) {
    subject = dropDefaults(subject as Record<string, unknown>, defaults)
  }
  const ordered = normalise(subject, '', schema, options.keyOrder ?? [])
  return `${JSON.stringify(ordered, null, 2)}\n`
}

/** Declaration order of a Zod object's keys. */
export function schemaKeyOrder(schema: z.ZodObject): readonly string[] {
  return Object.keys(schema.shape)
}

/**
 * Defaults a Zod object declares. Each field is probed with `undefined` rather than parsing `{}`,
 * which would fail on any required field.
 */
export function schemaDefaults(schema: z.ZodObject): Record<string, unknown> {
  const defaults: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(schema.shape)) {
    const probed = (field as z.ZodType).safeParse(undefined)
    if (probed.success && probed.data !== undefined) defaults[key] = probed.data
  }
  return defaults
}
