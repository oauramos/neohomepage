import ICAL from 'ical.js'

/**
 * iCalendar -> JSON: a flat array of occurrences in UTC ISO-8601, recurrences already expanded,
 * so the projection DSL never has to parse RFC 5545.
 */

export type IcsEvent = {
  readonly uid: string
  readonly summary: string
  readonly description: string | null
  readonly location: string | null
  /** UTC ISO-8601; an all-day event is anchored at UTC midnight of the date as written. */
  readonly start: string
  readonly end: string
  readonly allDay: boolean
  readonly status: string | null
  readonly url: string | null
  readonly recurring: boolean
}

export type IcsWindow = {
  /** The request's `now`, never a wall-clock read, so decoding is reproducible. */
  readonly now: string
  readonly pastDays: number
  readonly futureDays: number
  readonly maxEvents: number
}

export const DEFAULT_ICS_WINDOW = { pastDays: 1, futureDays: 90, maxEvents: 500 } as const

// Hard stop on expansion independent of the window: `RRULE:FREQ=SECONDLY` is legal and would
// otherwise spin for the length of the window. Counts iterations, not results, so the bound holds
// when every instance is discarded.
const MAX_ITERATIONS_PER_EVENT = 10_000

const DAY_MS = 86_400_000

export class IcsParseError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'IcsParseError'
  }
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * ICAL.Time -> UTC ISO-8601. A DATE value carries no timezone and `toJSDate()` resolves it in the
 * server's local zone, so all-day events are anchored at UTC midnight of the date as written.
 */
function iso(time: ICAL.Time): string {
  if (time.isDate === true) {
    const pad = (value: number) => String(value).padStart(2, '0')
    return `${time.year}-${pad(time.month)}-${pad(time.day)}T00:00:00.000Z`
  }
  return time.toJSDate().toISOString()
}

/** The same value as a Date, so window comparisons use the same anchoring the output does. */
function instant(time: ICAL.Time): Date {
  return new Date(iso(time))
}

/**
 * Decode a VCALENDAR into the occurrences inside a window. A malformed event is skipped and the
 * rest still renders; only a body that is not iCalendar at all throws.
 */
export function decodeIcs(body: string, window: IcsWindow): { events: IcsEvent[]; count: number } {
  let root: ICAL.Component
  try {
    root = new ICAL.Component(ICAL.parse(body))
  } catch (error) {
    throw new IcsParseError('the target did not return valid iCalendar data', error)
  }

  // Without the calendar's VTIMEZONEs registered, ical.js has no definition for a TZID and treats
  // the time as floating.
  for (const vtimezone of root.getAllSubcomponents('vtimezone')) {
    try {
      const zone = new ICAL.Timezone(vtimezone)
      if (!ICAL.TimezoneService.has(zone.tzid)) ICAL.TimezoneService.register(zone)
    } catch {
      // A broken VTIMEZONE degrades to floating time for the events that reference it.
    }
  }

  const anchor = Date.parse(window.now)
  if (!Number.isFinite(anchor)) throw new IcsParseError('the decode window has no valid instant')

  const from = new Date(anchor - window.pastDays * DAY_MS)
  const to = new Date(anchor + window.futureDays * DAY_MS)
  const toTime = ICAL.Time.fromJSDate(to, true)

  const events: IcsEvent[] = []

  for (const vevent of root.getAllSubcomponents('vevent')) {
    if (events.length >= window.maxEvents) break
    try {
      collect(vevent, from, to, toTime, window.maxEvents, events)
    } catch {
      // An unreadable event is skipped, not fatal.
    }
  }

  // Chronological, so a projection can `limit` without sorting and merges start from sorted input.
  events.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
  return { events, count: events.length }
}

function collect(
  vevent: ICAL.Component,
  from: Date,
  to: Date,
  toTime: ICAL.Time,
  maxEvents: number,
  out: IcsEvent[],
): void {
  const event = new ICAL.Event(vevent)

  // ical.js folds RECURRENCE-ID overrides into the parent through the iterator; emitting them here
  // too would double-count the instance.
  if (event.isRecurrenceException()) return

  const base = {
    uid: text(event.uid) ?? '',
    summary: text(event.summary) ?? '(untitled)',
    description: text(event.description),
    location: text(event.location),
    status: text(vevent.getFirstPropertyValue('status')),
    url: text(vevent.getFirstPropertyValue('url')),
  }

  if (!event.isRecurring()) {
    const start = event.startDate
    if (start === null || start === undefined) return
    const end = event.endDate ?? start
    if (instant(end) < from || instant(start) > to) return
    out.push({
      ...base,
      start: iso(start),
      end: iso(end),
      allDay: start.isDate === true,
      recurring: false,
    })
    return
  }

  const iterator = event.iterator()
  let iterations = 0
  for (;;) {
    if (out.length >= maxEvents) return
    if (++iterations > MAX_ITERATIONS_PER_EVENT) return
    const next = iterator.next()
    if (next === null || next === undefined) return
    if (next.compare(toTime) > 0) return

    const details = event.getOccurrenceDetails(next)
    if (instant(details.endDate) < from) continue

    out.push({
      ...base,
      // The occurrence carries its own summary: a RECURRENCE-ID override may rename one instance.
      summary: text(details.item.summary) ?? base.summary,
      start: iso(details.startDate),
      end: iso(details.endDate),
      allDay: details.startDate.isDate === true,
      recurring: true,
    })
  }
}
