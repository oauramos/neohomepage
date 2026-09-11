import { z } from 'zod'

/**
 * The universal render contract: every widget projects into this one shape, so a fixed set of
 * templates renders an unbounded set of integrations.
 */

const timeValue = z.object({ v: z.string(), iso: z.string(), rel: z.literal(true) })

/** A formatted scalar: a plain string, a number, or a time that the client can re-render. */
export const displayValueSchema = z.union([z.string(), z.number(), timeValue, z.null()])
export type DisplayValue = z.infer<typeof displayValueSchema>

export const projectionSchema = z.object({
  status: z.enum(['ok', 'degraded', 'down', 'unknown']).optional(),
  stats: z
    .array(
      z.object({
        label: z.string().max(48),
        value: displayValueSchema,
        hint: z.string().max(120).optional(),
        tone: z.enum(['ok', 'warn', 'bad']).optional(),
      }),
    )
    .max(12)
    .optional(),
  items: z
    .array(
      z.object({
        title: z.string().max(200),
        subtitle: z.string().max(200).optional(),
        badge: displayValueSchema.optional(),
        icon: z.string().max(64).optional(),
        href: z.string().max(2048).optional(),
        /** 0..1. Rendered as a bar, so out-of-range values are a manifest bug. */
        progress: z.number().min(0).max(1).optional(),
      }),
    )
    .max(50)
    .optional(),
  gauges: z
    .array(
      z.object({
        label: z.string().max(48),
        used: z.number(),
        total: z.number(),
        unit: z.enum(['bytes', 'percent', 'number']).optional(),
      }),
    )
    .max(12)
    .optional(),
})

export type Projection = z.infer<typeof projectionSchema>

/**
 * What the browser receives for one widget; `projection` is null until the widget has
 * succeeded once.
 */
export type ProjectionEnvelope = {
  readonly projection: Projection | null
  readonly meta: {
    readonly fetchedAt: string
    readonly ageMs: number
    readonly state: 'fresh' | 'stale' | 'error'
    /** A code, never a URL and never an upstream message — those have leaked API keys before. */
    readonly errorCode?: string
  }
}
