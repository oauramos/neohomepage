import type { Field, Manifest } from '@neohomepage/catalog-schema'
import { isComposite, sourceKinds } from '@neohomepage/catalog-schema'

/**
 * The fields a target of a given shape is allowed to carry.
 *
 * A target's `widgetType` names either a single-source manifest or one source kind of a composite
 * — a calendar's Sonarr binding is a target shaped like `sonarr-queue`, and its ICS feed is one
 * shaped like `ics-feed`, which exists only inside the calendar manifest. Both have to resolve or
 * the server cannot tell which of a target's values are credentials.
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
 * Split a caller's values into "may be written to config" and "must go to the vault".
 *
 * Where the manifest can speak, it decides — never the caller. The browser used to send `fields`
 * and `secrets` already separated, which meant a bug in the form, or a hostile client, could put
 * an API key in the bucket that gets committed to git. It did exactly that once: a whole draft
 * object was spread into `base` and the key landed in `config/targets/*.json` in plaintext.
 *
 * Where the manifest cannot speak — a hand-made `custom` target with no shape in the catalog —
 * the caller's own buckets are honoured, because the alternative is silently discarding a
 * credential and leaving the user with an unexplained "credential unavailable". The security
 * property that matters survives either way: a value the manifest declares secret has no path
 * into config. Marking something secret that is not merely stores a hostname in the vault.
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
    // An unclassified bag against an unknown shape cannot be sorted: writing it to config might
    // commit a credential, and writing it to the vault might hide a hostname. Report, do neither.
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
