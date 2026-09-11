import type { Manifest } from '@neohomepage/catalog-schema'
import { isComposite, sourceKinds } from '@neohomepage/catalog-schema'
import type { AuthContext } from './auth.ts'
import {
  executeOperation,
  executeSource,
  type ExecuteResult,
  type TargetBinding,
} from './execute.ts'

/** Picks and runs one probe for either manifest shape; composites have no `operations`. */

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
  })
}
