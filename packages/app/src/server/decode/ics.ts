import ICAL from 'ical.js'

/**
 * iCalendar -> JSON, so the projection DSL never has to learn a second grammar.
 *
 * The DSL is deliberately total and non-recursive; RFC 5545 is neither. Parsing here keeps the
 * evaluator small and puts the one genuinely hard part of calendars — expanding a recurrence rule
 * into concrete instants, in the right timezone — behind a library instead of behind 29 opcodes.
 *
 * Output is a flat array of occurrences already resolved to UTC ISO-8601 strings. A recurring
 * event is not "one event with a rule"; it is however many instances fall inside the window. That
 * makes the projection a plain `map` and makes a unified calendar a plain merge, with no opcode
 * that knows what a Tuesday is.
 */

export type IcsEvent = {
  readonly uid: string
  readonly summary: string
  readonly description: string | null
  readonly location: string | null
  /** UTC ISO-8601. An all-day event is midnight in the calendar's own timezone, then converted. */
  readonly start: string
  readonly end: string
  readonly allDay: boolean
  readonly status: string | null
  readonly url: string | null
  readonly recurring: boolean
}

export type IcsWindow = {
  /** The request's `now`. Never a wall-clock read here: decoding has to be reproducible. */
  readonly now: string
  readonly pastDays: number
  readonly futureDays: number
  readonly maxEvents: number
}

export const DEFAULT_ICS_WINDOW = { pastDays: 1, futureDays: 90, maxEvents: 500 } as const

/**
 * A hard stop on expansion, independent of the window.
 *
 * `RRULE:FREQ=SECONDLY` is legal iCalendar and would otherwise spin the event loop for the length
 * of the window before producing anything. Counting iterations rather than results is what makes
 * the bound hold even when every instance falls outside the window and is discarded.
 */
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
 * ICAL.Time -> UTC ISO-8601.
 *
 * A timed value goes through `toJSDate()`, so the zone conversion stays the library's problem. A
 * DATE value does NOT: it carries no timezone, and `toJSDate()` resolves it in the *server's*
 * local zone. That would make "2026-09-20, all day" decode to 03:00Z on a NAS in São Paulo and
 * 23:00Z the previous day on one in Auckland — the same feed, different agendas, and a recorded
 * fixture that only passes in the timezone its author happened to be in. All-day events are
 * anchored at UTC midnight of the date as written.
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
 * Decode a VCALENDAR into the occurrences inside a window.
 *
 * A malformed *event* throws nothing: the component is skipped and the rest of the calendar still
 * renders, which is the same partial-render posture the DSL has. Only a body that is not
 * iCalendar at all is an error, because that one is a misconfigured URL and the user has to hear
 * about it.
 */
export function decodeIcs(body: string, window: IcsWindow): { events: IcsEvent[]; count: number } {
  let root: ICAL.Component
  try {
    root = new ICAL.Component(ICAL.parse(body))
  } catch (error) {
    throw new IcsParseError('the target did not return valid iCalendar data', error)
  }

  // Register the calendar's own VTIMEZONEs before reading any DTSTART. Without this, ical.js has
  // no definition for a TZID like "America/Sao_Paulo" and treats the time as floating — an
  // off-by-hours error that never shows up for whoever is testing in UTC.
  for (const vtimezone of root.getAllSubcomponents('vtimezone')) {
    try {
      const zone = new ICAL.Timezone(vtimezone)
      if (!ICAL.TimezoneService.has(zone.tzid)) ICAL.TimezoneService.register(zone)
    } catch {
      // A broken VTIMEZONE degrades to floating time for the events that reference it, which
      // beats refusing the whole calendar.
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
      // One unreadable event does not cost the user the other forty.
    }
  }

  // Chronological, so a projection that only wants the next five can `limit` without sorting, and
  // a merge of several calendars starts from sorted inputs.
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

  // A RECURRENCE-ID component is a modified instance of a series. ical.js folds those into the
  // parent through the iterator, so emitting them here as well would double-count that instance.
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
    // Compared as instants, not as bare dates: an all-day event in a +13 zone is inside a UTC
    // window that a date-only comparison would put it outside of.
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
