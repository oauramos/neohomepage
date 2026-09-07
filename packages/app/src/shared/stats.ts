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
 * Growth from the first window to the last, as a percentage of the first.
 *
 * This is the number that matters for a dashboard left open on a wall tablet for a month: a
 * process can sit comfortably under its budget and still be leaking. Comparing窗 means rather
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
