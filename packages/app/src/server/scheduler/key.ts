import { createHash } from 'node:crypto'

/**
 * The schedulable unit is a fetch, not a widget: widgets with identical parts share one key.
 * `targetRevision` is part of the key so repointing a target invalidates everything cached
 * against it.
 */
export type FetchKeyParts = {
  readonly targetId: string
  readonly targetRevision: string
  readonly operation: string
  readonly params: Readonly<Record<string, unknown>>
}

/** Stable regardless of key insertion order, so two callers agree on the same fetch. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b, 'en-US'))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
}

export function fetchKey(parts: FetchKeyParts): string {
  const material = [
    parts.targetId,
    parts.targetRevision,
    parts.operation,
    canonical(parts.params),
  ].join(' ')
  return createHash('sha256').update(material).digest('hex').slice(0, 24)
}

export { canonical as canonicalJson }
