/** Pure statistics for the memory harness. */

export function mean(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN
  return values.reduce((a, b) => a + b, 0) / values.length
}

/** Nearest-rank percentile; `p` is 0..100, p=0 is the minimum and p=100 the maximum. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN
  if (!(p >= 0 && p <= 100)) throw new RangeError(`percentile out of range: ${p}`)
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1))
  return sorted[index] as number
}

/**
 * Smallest sample size for which a nearest-rank quantile is not simply the maximum:
 * `ceil(0.95 * n) === n` for every n up to 19, so a "p95" over fewer samples is the max.
 */
export function minimumSamplesFor(p: number): number {
  if (p >= 100 || p <= 0) return 1
  // Searched, not solved: the closed form `ceil(1 / (1 - p/100))` is off by one wherever the
  // division lands just above an integer (1/(1-0.9) is 10.000000000000002).
  for (let n = 2; n <= 10_000; n++) {
    if (Math.ceil((p / 100) * n) < n) return n
  }
  return 10_000
}

/** Nearest-rank percentile, or null when the sample is too small for it to be more than the max. */
export function tailPercentile(values: readonly number[], p: number): number | null {
  return values.length >= minimumSamplesFor(p) ? percentile(values, p) : null
}

/**
 * Growth from the first window to the last, as a percentage of the first. Window means rather
 * than single samples keep GC sawtooth from reading as a trend.
 */
export function drift(values: readonly number[], windowFraction = 0.25): number {
  if (values.length < 4) return Number.NaN
  const size = Math.max(1, Math.floor(values.length * windowFraction))
  const first = mean(values.slice(0, size))
  const last = mean(values.slice(-size))
  if (first === 0) return Number.NaN
  return ((last - first) / first) * 100
}
