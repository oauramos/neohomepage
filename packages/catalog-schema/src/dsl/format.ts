import type { Json } from '../json.ts'

/**
 * Terminal formatting. Locale is pinned to en-US and never taken from the host, so a recorded
 * fixture produces the same bytes on a contributor's machine, in CI, and on the user's NAS.
 *
 * Time-relative formats return `{ v, iso }` rather than a bare string. A published generation is
 * static HTML: without the raw instant travelling alongside the rendered text, a page rendered
 * three hours ago would keep insisting the episode airs "in 5 minutes" forever.
 */
export type FormattedTime = { readonly v: string; readonly iso: string; readonly rel: true }

const NUMBER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })
const DATE = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' })

function asNumber(value: Json): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function scale(value: number, base: number, units: readonly string[]): string {
  let magnitude = Math.abs(value)
  let index = 0
  while (magnitude >= base && index < units.length - 1) {
    magnitude /= base
    index++
  }
  const signed = value < 0 ? -magnitude : magnitude
  return `${NUMBER.format(signed)} ${units[index] as string}`
}

export function formatBytes(value: Json): Json {
  const n = asNumber(value)
  return n === null ? null : scale(n, 1024, ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'])
}

export function formatBitrate(value: Json): Json {
  const n = asNumber(value)
  return n === null ? null : scale(n, 1000, ['bps', 'kbps', 'Mbps', 'Gbps'])
}

/** Seconds to a compact human duration: 0 is "0s", never an empty string. */
export function formatDuration(value: Json): Json {
  const n = asNumber(value)
  if (n === null) return null
  const total = Math.floor(Math.abs(n))
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const parts: string[] = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0 && days === 0) parts.push(`${minutes}m`)
  if (parts.length === 0) parts.push(`${seconds}s`)
  const rendered = parts.slice(0, 2).join(' ')
  return n < 0 ? `-${rendered}` : rendered
}

/** A fraction in 0..1 becomes a percentage. 0.42 -> "42%". */
export function formatPercent(value: Json): Json {
  const n = asNumber(value)
  return n === null ? null : `${NUMBER.format(n * 100)}%`
}

export function formatNumber(value: Json): Json {
  const n = asNumber(value)
  return n === null ? null : NUMBER.format(n)
}

export function formatTemperature(value: Json): Json {
  const n = asNumber(value)
  return n === null ? null : `${NUMBER.format(n)}°`
}

function toInstant(value: Json): Date | null {
  if (typeof value === 'number') {
    const fromEpoch = new Date(value < 1e12 ? value * 1000 : value)
    return Number.isNaN(fromEpoch.getTime()) ? null : fromEpoch
  }
  if (typeof value !== 'string' || value.trim() === '') return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export function formatDate(value: Json): Json {
  const instant = toInstant(value)
  if (instant === null) return null
  return { v: DATE.format(instant), iso: instant.toISOString(), rel: true } satisfies FormattedTime
}

const RELATIVE = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' })
const DIVISIONS: readonly [number, Intl.RelativeTimeFormatUnit][] = [
  [60, 'second'],
  [3600, 'minute'],
  [86400, 'hour'],
  [604800, 'day'],
  [2629800, 'week'],
  [31557600, 'month'],
  [Infinity, 'year'],
]

/** `now` is passed in, never read from the clock, so evaluation stays deterministic. */
export function formatRelativeTime(value: Json, now: string): Json {
  const instant = toInstant(value)
  const reference = toInstant(now)
  if (instant === null || reference === null) return null

  const deltaSeconds = (instant.getTime() - reference.getTime()) / 1000
  const magnitude = Math.abs(deltaSeconds)
  let unit: Intl.RelativeTimeFormatUnit = 'second'
  let divisor = 1
  let previous = 1
  for (const [boundary, candidate] of DIVISIONS) {
    if (magnitude < boundary) {
      unit = candidate
      divisor = previous
      break
    }
    previous = boundary
  }
  const rendered = RELATIVE.format(Math.round(deltaSeconds / divisor), unit)
  return { v: rendered, iso: instant.toISOString(), rel: true } satisfies FormattedTime
}
