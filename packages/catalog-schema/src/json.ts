/** Every value the DSL produces must survive a round trip through JSON: projections are cached to
 *  disk, baked into a published generation, and pushed to browsers. No Date, no undefined, no Map. */
export type Json =
  null | boolean | number | string | readonly Json[] | { readonly [k: string]: Json }

export type JsonObject = { readonly [k: string]: Json }

export function isJsonObject(value: Json): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isJsonArray(value: Json): value is readonly Json[] {
  return Array.isArray(value)
}
