import type { Manifest } from '@neohomepage/catalog-schema'
import { isComposite, sourceKinds } from '@neohomepage/catalog-schema'
import type { AuthContext } from './auth.ts'
import type { FetchLimits } from './client.ts'
import {
  executeOperation,
  executeSource,
  type ExecuteResult,
  type TargetBinding,
} from './execute.ts'

/**
 * "Does this credential reach this box?", for both manifest shapes.
 *
 * The install form, the MCP `test_target` tool and `neo fetch` all ask exactly this question, and
 * all three used to ask it by reaching into `manifest.operations` themselves. Composites have no
 * `operations`, so that reach is now a compile error and this is the one place that knows how to
 * pick a probe for either shape.
 */

export type ProbeInput = {
  readonly manifest: Manifest
  /** Composite: which source kind to probe. Defaults to the first kind of the first role. */
  readonly kind?: string | undefined
  /** Single: which operation to probe. Defaults to the first the manifest declares. */
  readonly operation?: string | undefined
  readonly target: TargetBinding
  readonly config: Readonly<Record<string, unknown>>
  readonly auth: AuthContext
  readonly now: string
  readonly limits?: Partial<FetchLimits>
}

export function probeNames(manifest: Manifest): string[] {
  return isComposite(manifest)
    ? sourceKinds(manifest).map((entry) => entry.kind)
    : Object.keys(manifest.operations)
}

export async function probe(input: ProbeInput): Promise<ExecuteResult> {
  const { manifest } = input

  if (isComposite(manifest)) {
    const kinds = sourceKinds(manifest)
    const chosen =
      input.kind === undefined ? kinds[0] : kinds.find((entry) => entry.kind === input.kind)
    if (chosen === undefined) {
      return {
        ok: false,
        code: 'unknown-kind',
        message:
          input.kind === undefined
            ? 'this widget declares no source kinds'
            : `no source kind "${input.kind}" — this widget accepts ${kinds
                .map((entry) => entry.kind)
                .join(', ')}`,
      }
    }
    return executeSource({
      source: chosen.source,
      target: input.target,
      config: input.config,
      auth: input.auth,
      now: input.now,
      ...(input.limits === undefined ? {} : { limits: input.limits }),
    })
  }

  const operation = input.operation ?? Object.keys(manifest.operations)[0]
  if (operation === undefined) {
    return { ok: false, code: 'no-operations', message: 'this widget declares no operations' }
  }
  return executeOperation({
    manifest,
    operation,
    target: input.target,
    config: input.config,
    auth: input.auth,
    now: input.now,
    ...(input.limits === undefined ? {} : { limits: input.limits }),
  })
}
