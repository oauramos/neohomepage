/**
 * Failure backoff and idle decay for poll intervals; the dashboard usually shares a box with the
 * services it polls.
 */

export type BackoffPolicy = {
  /** Failures tolerated at the normal interval before the interval starts stretching. */
  readonly grace: number
  readonly multiplier: number
  readonly maxIntervalMs: number
  /** Interval used once nothing has been watching for `idleAfterMs`. */
  readonly idleIntervalMs: number
  readonly idleAfterMs: number
}

export const DEFAULT_BACKOFF: BackoffPolicy = {
  grace: 2,
  multiplier: 5,
  maxIntervalMs: 15 * 60_000,
  idleIntervalMs: 10 * 60_000,
  idleAfterMs: 5 * 60_000,
}

export type IntervalInput = {
  readonly baseIntervalMs: number
  readonly consecutiveFailures: number
  readonly subscribers: number
  readonly unobservedForMs: number
  readonly policy?: BackoffPolicy
}

/** Next interval for one fetch key: failure backoff past `grace`, then idle decay. */
export function nextIntervalMs(input: IntervalInput): number {
  const policy = input.policy ?? DEFAULT_BACKOFF

  let interval = input.baseIntervalMs
  if (input.consecutiveFailures > policy.grace) {
    const steps = input.consecutiveFailures - policy.grace
    interval = Math.min(policy.maxIntervalMs, interval * policy.multiplier ** steps)
  }

  if (input.subscribers === 0 && input.unobservedForMs >= policy.idleAfterMs) {
    // Idleness never speeds up a target that has already backed off further.
    interval = Math.max(interval, policy.idleIntervalMs)
  }
  return Math.round(interval)
}

/**
 * Spread an interval by up to a tenth either way so equal intervals do not align into one burst.
 * `random` is injectable for deterministic tests.
 */
export function withJitter(intervalMs: number, random: () => number = Math.random): number {
  const spread = intervalMs * 0.1
  return Math.max(1, Math.round(intervalMs + (random() * 2 - 1) * spread))
}
