import { describe, expect, it } from 'vitest'
import { drift, mean, percentile } from './stats.ts'

describe('percentile', () => {
  it('puts p0 at the minimum and p100 at the maximum', () => {
    const v = [5, 1, 9, 3, 7]
    expect(percentile(v, 0)).toBe(1)
    expect(percentile(v, 100)).toBe(9)
  })

  it('agrees with a hand-computed nearest-rank result', () => {
    const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    expect(percentile(v, 50)).toBe(5)
    expect(percentile(v, 95)).toBe(10)
    expect(percentile(v, 90)).toBe(9)
  })

  it('does not mutate its input', () => {
    const v = [3, 1, 2]
    percentile(v, 50)
    expect(v).toEqual([3, 1, 2])
  })

  it('rejects a percentile outside 0..100 instead of returning undefined', () => {
    expect(() => percentile([1, 2], 101)).toThrow(RangeError)
    expect(() => percentile([1, 2], -1)).toThrow(RangeError)
  })

  it('returns NaN for no samples rather than 0, which would read as a pass', () => {
    expect(percentile([], 95)).toBeNaN()
    expect(mean([])).toBeNaN()
  })
})

describe('drift', () => {
  it('reports zero for a flat series', () => {
    expect(drift(Array.from({ length: 20 }, () => 100))).toBeCloseTo(0)
  })

  it('reports growth as a percentage of the opening window', () => {
    // First quarter averages 100, last quarter averages 150.
    const v = [...Array.from({ length: 10 }, () => 100), ...Array.from({ length: 10 }, () => 150)]
    expect(drift(v)).toBeCloseTo(50)
  })

  it('is not fooled by GC sawtooth around a flat mean', () => {
    const v = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 90 : 110))
    expect(Math.abs(drift(v))).toBeLessThan(5)
  })
})
