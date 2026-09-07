/**
 * Pure statistics for the memory harness. Kept here, and tested, because a percentile that is
 * quietly off by one turns a failing budget into a passing one and nobody notices.
 */

export function mean(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN
  return values.reduce((a, b) => a + b, 0) / values.length
}

/**
 * Nearest-rank percentile on the sorted copy. `p` is 0..100.
 * p=0 is the minimum and p=100 the maximum, so a "p100" and a "peak" always agree.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN
  if (!(p >= 0 && p <= 100)) throw new RangeError(`percentile out of range: ${p}`)
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1))
  return sorted[index] as number
}

/**
 * The smallest sample size for which a nearest-rank quantile is not simply the maximum.
 *
 * With nearest rank, `ceil(0.95 * n) === n` for every n up to 19 — so `percentile(x, 95)` over
 * three samples returns the largest of the three, and calling that a "p95" is not a rounding
 * quibble. It is a gate with zero outlier tolerance that gets STRICTER as you add samples, which
 * is the exact opposite of what more samples are for. A CI budget was written that way here, and
 * it failed builds on a busy runner while the code was unchanged.
 */
export function minimumSamplesFor(p: number): number {
  if (p >= 100 || p <= 0) return 1
  // Searched rather than solved. The closed form `ceil(1 / (1 - p/100))` is off by one wherever
  // the division lands just above an integer — 1/(1-0.9) is 10.000000000000002, so p90 comes back
  // as 11 when 10 samples are demonstrably enough. Using floating point to reason about a
  // floating-point edge case is how the original bug got here.
  for (let n = 2; n <= 10_000; n++) {
    if (Math.ceil((p / 100) * n) < n) return n
  }
  return 10_000
}

/**
 * A percentile that refuses to be a maximum in disguise.
 *
 * Returns null rather than a misleading number when the sample is too small for the quantile
 * asked for, so a caller has to decide what to do instead of unknowingly gating on the max.
 */
export function tailPercentile(values: readonly number[], p: number): number | null {
  return values.length >= minimumSamplesFor(p) ? percentile(values, p) : null
}

/**
 * Growth from the first window to the last, as a percentage of the first.
 *
 * This is the number that matters for a dashboard left open on a wall tablet for a month: a
 * process can sit comfortably under its budget and still be leaking. Comparing window means rather
 * than single samples keeps GC sawtooth from being read as a trend.
 */
export function drift(values: readonly number[], windowFraction = 0.25): number {
  if (values.length < 4) return Number.NaN
  const size = Math.max(1, Math.floor(values.length * windowFraction))
  const first = mean(values.slice(0, size))
  const last = mean(values.slice(-size))
  if (first === 0) return Number.NaN
  return ((last - first) / first) * 100
}
