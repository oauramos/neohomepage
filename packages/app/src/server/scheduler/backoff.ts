/**
 * Failure backoff and idle decay.
 *
 * Both exist for the same reason: the box running this dashboard is usually the box running the
 * services it polls. Hammering a dead Sonarr every 60 seconds costs the user twice — once in
 * wasted work, and again because the dashboard gets blamed for the slowness it caused.
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
  /** Live subscribers right now. Zero means nobody has the dashboard open. */
  readonly subscribers: number
  /** How long there has been nobody watching. */
  readonly unobservedForMs: number
  readonly policy?: BackoffPolicy
}

/**
 * The interval one fetch key should use next.
 *
 * Idle decay is the single largest saving in the design: a home dashboard is unobserved roughly
 * twenty-two hours a day, and polling forty services through the night for nobody is the
 * difference between a background process and a nuisance.
 */
export function nextIntervalMs(input: IntervalInput): number {
  const policy = input.policy ?? DEFAULT_BACKOFF

  let interval = input.baseIntervalMs
  if (input.consecutiveFailures > policy.grace) {
    const steps = input.consecutiveFailures - policy.grace
    interval = Math.min(policy.maxIntervalMs, interval * policy.multiplier ** steps)
  }

  if (input.subscribers === 0 && input.unobservedForMs >= policy.idleAfterMs) {
    // Never speed up because of idleness: a failing target that has already backed off past the
    // idle interval must stay backed off.
    interval = Math.max(interval, policy.idleIntervalMs)
  }
  return Math.round(interval)
}

/**
 * Spread scheduling by up to a tenth either way.
 *
 * Forty widgets configured at 60 seconds otherwise align permanently after the first tick and
 * fire as one burst, which is what turns a comfortable poll rate into a visible stutter.
 * `random` is injected so tests are deterministic.
 */
export function withJitter(intervalMs: number, random: () => number = Math.random): number {
  const spread = intervalMs * 0.1
  return Math.max(1, Math.round(intervalMs + (random() * 2 - 1) * spread))
}
