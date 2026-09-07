import { describe, expect, it } from 'vitest'
import { parseCgroupV1Limit, parseCgroupV2Max, describeMemoryEnvironment } from './runtime.ts'

describe('cgroup v2 memory.max', () => {
  it('reads a byte limit', () => {
    expect(parseCgroupV2Max('1073741824\n')).toBe(1073741824)
  })

  it('treats the literal `max` as no limit rather than as zero', () => {
    expect(parseCgroupV2Max('max\n')).toBeNull()
    expect(parseCgroupV2Max('  max  ')).toBeNull()
  })

  it('refuses garbage instead of producing NaN', () => {
    expect(parseCgroupV2Max('')).toBeNull()
    expect(parseCgroupV2Max('not-a-number')).toBeNull()
    expect(parseCgroupV2Max('-1')).toBeNull()
  })
})

describe('cgroup v1 memory.limit_in_bytes', () => {
  it('reads a byte limit', () => {
    expect(parseCgroupV1Limit('536870912\n')).toBe(536870912)
  })

  it('recognises the v1 unlimited sentinel', () => {
    // v1 has no `max` keyword: unlimited is a number just under 2^63, and reading it as a real
    // limit would make every check pass and hide a missing limit.
    expect(parseCgroupV1Limit('9223372036854771712')).toBeNull()
  })

  it('refuses garbage', () => {
    expect(parseCgroupV1Limit('nope')).toBeNull()
    expect(parseCgroupV1Limit('0')).toBeNull()
  })
})

describe('describeMemoryEnvironment', () => {
  it('reports a coherent environment on whatever host it runs on', () => {
    const e = describeMemoryEnvironment()
    expect(e.osTotalBytes).toBeGreaterThan(0)
    expect(e.v8HeapLimitBytes).toBeGreaterThan(0)
    expect(e.effectiveLimitBytes).toBeGreaterThan(0)
    // With no cgroup limit, the effective limit must fall back to physical memory.
    if (e.cgroup.limitBytes === null) expect(e.effectiveLimitBytes).toBe(e.osTotalBytes)
    else expect(e.effectiveLimitBytes).toBe(e.cgroup.limitBytes)
    expect(e.heapLimitExceedsMemoryLimit).toBe(e.v8HeapLimitBytes > e.effectiveLimitBytes)
  })
})
