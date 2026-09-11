import type { Field, Manifest } from '@neohomepage/catalog-schema'
import { isComposite, sourceKinds } from '@neohomepage/catalog-schema'

/**
 * Fields a target of a given shape may carry. `widgetType` names either a single-source manifest
 * or one source kind of a composite (e.g. `ics-feed`, which exists only inside the calendar one).
 */
export function targetShapeFields(
  catalog: ReadonlyMap<string, Manifest>,
  widgetType: string,
): readonly Field[] | null {
  const direct = catalog.get(widgetType)
  if (direct !== undefined && !isComposite(direct)) return direct.target.fields

  for (const manifest of catalog.values()) {
    if (!isComposite(manifest)) continue
    for (const entry of sourceKinds(manifest)) {
      if (entry.kind === widgetType) return entry.source.fields
    }
  }
  return null
}

export type RoutedValues = {
  /** Non-secret values, safe for config/. Anything undeclared has been dropped. */
  readonly fields: Record<string, string | number | boolean>
  /** Values for fields the MANIFEST declares secret. These only ever go to the vault. */
  readonly secrets: Record<string, string>
  /** Names the caller sent that the manifest does not declare, so a caller can be told. */
  readonly unknown: readonly string[]
}

/**
 * Splits a caller's values into config-safe fields and vault secrets. When the shape is declared
 * the manifest decides, never the caller: a declared secret has no path into config. With no shape
 * (a hand-made `custom` target) the caller's buckets are honoured rather than dropping a secret.
 */
export function routeValues(
  declared: readonly Field[] | null,
  input: {
    /** Unclassified. Only routable when the shape is known. */
    readonly values?: Readonly<Record<string, unknown>> | undefined
    readonly fields?: Readonly<Record<string, unknown>> | undefined
    readonly secrets?: Readonly<Record<string, unknown>> | undefined
  },
): RoutedValues {
  const fields: Record<string, string | number | boolean> = {}
  const secrets: Record<string, string> = {}
  const unknown: string[] = []

  const scalar = (value: unknown): string | number | boolean | null =>
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? value
      : null

  if (declared === null) {
    for (const [name, value] of Object.entries(input.secrets ?? {})) {
      if (value !== null && value !== undefined) secrets[name] = String(value)
    }
    for (const [name, value] of Object.entries(input.fields ?? {})) {
      const plain = scalar(value)
      if (plain !== null) fields[name] = plain
    }
    // Unclassified values against an unknown shape: config might commit a credential, the vault
    // might hide a hostname, so report them instead.
    unknown.push(...Object.keys(input.values ?? {}))
    return { fields, secrets, unknown }
  }

  const all = { ...input.fields, ...input.secrets, ...input.values }
  for (const [name, value] of Object.entries(all)) {
    if (value === null || value === undefined) continue
    const field = declared.find((one) => one.name === name)
    if (field === undefined) {
      unknown.push(name)
      continue
    }
    if (field.kind === 'secret') {
      secrets[name] = String(value)
      continue
    }
    const plain = scalar(value)
    if (plain !== null) fields[name] = plain
  }

  return { fields, secrets, unknown }
}
