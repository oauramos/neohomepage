/**
 * Every DSL value must survive a JSON round trip: projections are cached to disk and pushed to
 * browsers.
 */
export type Json =
  null | boolean | number | string | readonly Json[] | { readonly [k: string]: Json }

export type JsonObject = { readonly [k: string]: Json }

export function isJsonObject(value: Json): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isJsonArray(value: Json): value is readonly Json[] {
  return Array.isArray(value)
}
