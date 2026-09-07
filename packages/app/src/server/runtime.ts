import { readFileSync } from 'node:fs'
import os from 'node:os'
import process from 'node:process'
import v8 from 'node:v8'

/**
 * What the runtime believes about the memory it is allowed to use.
 *
 * This exists because of one specific failure mode on the primary deployment target: inside an
 * unprivileged LXC or a memory-limited container, V8 may size its default heap from the HOST's
 * RAM rather than the cgroup limit. When that happens the process happily grows past the limit
 * and the kernel OOM-kills it instead of V8 running a GC — and on a Proxmox node that can take
 * neighbouring services down with it. If `heapLimitExceedsMemoryLimit` is true,
 * --max-old-space-size is mandatory rather than advisory.
 */
export type MemoryEnvironment = {
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly nodeVersion: string
  /** Physical memory the OS reports. Inside a container this is usually the HOST's. */
  readonly osTotalBytes: number
  readonly cgroup: CgroupLimit
  /** The ceiling V8 will let the old space reach before it gives up. */
  readonly v8HeapLimitBytes: number
  /** --max-old-space-size, if it was passed. */
  readonly maxOldSpaceMb: number | null
  /** The tightest real limit we can see: the cgroup limit if there is one, else physical memory. */
  readonly effectiveLimitBytes: number
  /** True when V8 would let the heap alone outgrow the memory we are actually allowed. */
  readonly heapLimitExceedsMemoryLimit: boolean
}

export type CgroupLimit = {
  readonly version: 'v2' | 'v1' | null
  /** null means "no limit set" (cgroup v2 reports the literal string `max`). */
  readonly limitBytes: number | null
  readonly source: string | null
}

/** cgroup v2 writes `max` for "unlimited"; v1 writes a sentinel close to 2^63. */
const V1_UNLIMITED_THRESHOLD = 0x7ffffffffffff000

export function parseCgroupV2Max(raw: string): number | null {
  const value = raw.trim()
  if (value === '' || value === 'max') return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

export function parseCgroupV1Limit(raw: string): number | null {
  const parsed = Number(raw.trim())
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  // v1 encodes "unlimited" as an enormous number rather than a keyword.
  return parsed >= V1_UNLIMITED_THRESHOLD ? null : parsed
}

function read(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

export function readCgroupLimit(): CgroupLimit {
  const v2 = read('/sys/fs/cgroup/memory.max')
  if (v2 !== null) {
    return { version: 'v2', limitBytes: parseCgroupV2Max(v2), source: '/sys/fs/cgroup/memory.max' }
  }
  const v1 = read('/sys/fs/cgroup/memory/memory.limit_in_bytes')
  if (v1 !== null) {
    return {
      version: 'v1',
      limitBytes: parseCgroupV1Limit(v1),
      source: '/sys/fs/cgroup/memory/memory.limit_in_bytes',
    }
  }
  return { version: null, limitBytes: null, source: null }
}

function readMaxOldSpaceMb(): number | null {
  const sources = [...process.execArgv, ...(process.env.NODE_OPTIONS ?? '').split(/\s+/)]
  for (const arg of sources) {
    const match = /^--max[-_]old[-_]space[-_]size=(\d+)$/.exec(arg)
    if (match?.[1] !== undefined) return Number(match[1])
  }
  return null
}

export function describeMemoryEnvironment(): MemoryEnvironment {
  const cgroup = readCgroupLimit()
  const osTotalBytes = os.totalmem()
  const v8HeapLimitBytes = v8.getHeapStatistics().heap_size_limit
  const effectiveLimitBytes = cgroup.limitBytes ?? osTotalBytes

  return {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    osTotalBytes,
    cgroup,
    v8HeapLimitBytes,
    maxOldSpaceMb: readMaxOldSpaceMb(),
    effectiveLimitBytes,
    heapLimitExceedsMemoryLimit: v8HeapLimitBytes > effectiveLimitBytes,
  }
}

export function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

export function formatMemoryEnvironment(e: MemoryEnvironment): string {
  const lines = [
    `node          ${e.nodeVersion} (${e.platform}/${e.arch})`,
    `os.totalmem   ${mib(e.osTotalBytes)}`,
    `cgroup        ${
      e.cgroup.version === null
        ? 'not present (not Linux, or not namespaced)'
        : `${e.cgroup.version} → ${e.cgroup.limitBytes === null ? 'no limit' : mib(e.cgroup.limitBytes)}`
    }`,
    `effective     ${mib(e.effectiveLimitBytes)}`,
    `v8 heap limit ${mib(e.v8HeapLimitBytes)}`,
    `max-old-space ${e.maxOldSpaceMb === null ? 'not set' : `${e.maxOldSpaceMb} MB`}`,
  ]
  if (e.heapLimitExceedsMemoryLimit) {
    lines.push(
      '',
      `WARNING: V8 would let the heap reach ${mib(e.v8HeapLimitBytes)}, past the ` +
        `${mib(e.effectiveLimitBytes)} this process is allowed. The kernel OOM killer, not V8, ` +
        'would decide what happens. Set --max-old-space-size.',
    )
  }
  return lines.join('\n')
}
