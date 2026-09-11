import { describe, expect, it } from 'vitest'
import { decodeIcs, IcsParseError, DEFAULT_ICS_WINDOW, type IcsWindow } from './ics.ts'
import { decode, DecodeError } from './index.ts'

const NOW = '2026-03-10T12:00:00.000Z'
const window = (overrides: Partial<Omit<IcsWindow, 'now'>> = {}): IcsWindow => ({
  now: NOW,
  ...DEFAULT_ICS_WINDOW,
  ...overrides,
})

function calendar(...body: string[]): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//neohomepage//test//EN',
    ...body,
    'END:VCALENDAR',
  ].join('\r\n')
}

describe('single events', () => {
  it('reads one timed event into UTC', () => {
    const { events } = decodeIcs(
      calendar(
        'BEGIN:VEVENT',
        'UID:a@example.invalid',
        'SUMMARY:Standup',
        'LOCATION:Kitchen',
        'STATUS:CONFIRMED',
        'DTSTART:20260311T090000Z',
        'DTEND:20260311T091500Z',
        'END:VEVENT',
      ),
      window(),
    )
    expect(events).toEqual([
      {
        uid: 'a@example.invalid',
        summary: 'Standup',
        description: null,
        location: 'Kitchen',
        status: 'CONFIRMED',
        url: null,
        start: '2026-03-11T09:00:00.000Z',
        end: '2026-03-11T09:15:00.000Z',
        allDay: false,
        recurring: false,
      },
    ])
  })

  it('anchors an all-day event at UTC midnight, whatever the server timezone is', () => {
    // ical.js resolves a DATE value in the host zone; on a non-UTC machine this would be 03:00Z.
    const { events } = decodeIcs(
      calendar(
        'BEGIN:VEVENT',
        'UID:b@example.invalid',
        'SUMMARY:Holiday',
        'DTSTART;VALUE=DATE:20260315',
        'DTEND;VALUE=DATE:20260316',
        'END:VEVENT',
      ),
      window(),
    )
    expect(events[0]).toMatchObject({
      allDay: true,
      summary: 'Holiday',
      start: '2026-03-15T00:00:00.000Z',
      end: '2026-03-16T00:00:00.000Z',
    })
  })

  it('converts a zoned time using the calendar VTIMEZONE, not the host zone', () => {
    // Without the VTIMEZONE registered, ical.js treats 09:00 as floating and returns 09:00Z.
    const { events } = decodeIcs(
      calendar(
        'BEGIN:VTIMEZONE',
        'TZID:America/Sao_Paulo',
        'BEGIN:STANDARD',
        'DTSTART:19700101T000000',
        'TZOFFSETFROM:-0300',
        'TZOFFSETTO:-0300',
        'TZNAME:-03',
        'END:STANDARD',
        'END:VTIMEZONE',
        'BEGIN:VEVENT',
        'UID:c@example.invalid',
        'SUMMARY:Almoço',
        'DTSTART;TZID=America/Sao_Paulo:20260311T090000',
        'DTEND;TZID=America/Sao_Paulo:20260311T100000',
        'END:VEVENT',
      ),
      window(),
    )
    expect(events[0]?.start).toBe('2026-03-11T12:00:00.000Z')
  })

  it('drops events outside the window at both ends', () => {
    const ics = calendar(
      'BEGIN:VEVENT',
      'UID:old@example.invalid',
      'SUMMARY:Last year',
      'DTSTART:20250101T090000Z',
      'DTEND:20250101T100000Z',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:far@example.invalid',
      'SUMMARY:Next year',
      'DTSTART:20270101T090000Z',
      'DTEND:20270101T100000Z',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:soon@example.invalid',
      'SUMMARY:Tomorrow',
      'DTSTART:20260311T090000Z',
      'DTEND:20260311T100000Z',
      'END:VEVENT',
    )
    expect(decodeIcs(ics, window()).events.map((e) => e.summary)).toEqual(['Tomorrow'])
  })

  it('keeps an event that started before the window but has not ended', () => {
    const { events } = decodeIcs(
      calendar(
        'BEGIN:VEVENT',
        'UID:long@example.invalid',
        'SUMMARY:Conference',
        'DTSTART:20260309T090000Z',
        'DTEND:20260312T170000Z',
        'END:VEVENT',
      ),
      window({ pastDays: 0 }),
    )
    expect(events).toHaveLength(1)
  })
})

describe('recurrence', () => {
  it('expands a weekly rule into one entry per occurrence', () => {
    const { events } = decodeIcs(
      calendar(
        'BEGIN:VEVENT',
        'UID:r@example.invalid',
        'SUMMARY:Weekly sync',
        'DTSTART:20260112T090000Z',
        'DTEND:20260112T093000Z',
        'RRULE:FREQ=WEEKLY;BYDAY=MO',
        'END:VEVENT',
      ),
      window({ futureDays: 21 }),
    )
    expect(events.map((e) => e.start)).toEqual([
      '2026-03-16T09:00:00.000Z',
      '2026-03-23T09:00:00.000Z',
      '2026-03-30T09:00:00.000Z',
    ])
    expect(events.every((e) => e.recurring)).toBe(true)
  })

  it('honours EXDATE', () => {
    const { events } = decodeIcs(
      calendar(
        'BEGIN:VEVENT',
        'UID:x@example.invalid',
        'SUMMARY:Weekly sync',
        'DTSTART:20260112T090000Z',
        'DTEND:20260112T093000Z',
        'RRULE:FREQ=WEEKLY;BYDAY=MO',
        'EXDATE:20260323T090000Z',
        'END:VEVENT',
      ),
      window({ futureDays: 21 }),
    )
    expect(events.map((e) => e.start)).toEqual([
      '2026-03-16T09:00:00.000Z',
      '2026-03-30T09:00:00.000Z',
    ])
  })

  it('applies a RECURRENCE-ID override once, not twice', () => {
    // The override is a second VEVENT with the same UID.
    const { events } = decodeIcs(
      calendar(
        'BEGIN:VEVENT',
        'UID:o@example.invalid',
        'SUMMARY:Weekly sync',
        'DTSTART:20260112T090000Z',
        'DTEND:20260112T093000Z',
        'RRULE:FREQ=WEEKLY;BYDAY=MO',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:o@example.invalid',
        'RECURRENCE-ID:20260316T090000Z',
        'SUMMARY:Weekly sync (moved)',
        'DTSTART:20260316T140000Z',
        'DTEND:20260316T143000Z',
        'END:VEVENT',
      ),
      window({ futureDays: 14 }),
    )
    const onThatMonday = events.filter((e) => e.start.startsWith('2026-03-16'))
    expect(onThatMonday).toHaveLength(1)
    expect(onThatMonday[0]).toMatchObject({
      summary: 'Weekly sync (moved)',
      start: '2026-03-16T14:00:00.000Z',
    })
  })

  it('terminates on a pathological rule instead of expanding the window second by second', () => {
    // FREQ=SECONDLY over the 90-day window is ~7.8 million instances.
    const started = process.hrtime.bigint()
    const { events } = decodeIcs(
      calendar(
        'BEGIN:VEVENT',
        'UID:evil@example.invalid',
        'SUMMARY:Tick',
        'DTSTART:20260310T120000Z',
        'DTEND:20260310T120001Z',
        'RRULE:FREQ=SECONDLY',
        'END:VEVENT',
      ),
      window({ maxEvents: 50 }),
    )
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
    expect(events).toHaveLength(50)
    expect(elapsedMs).toBeLessThan(2000)
  })
})

describe('robustness', () => {
  it('skips an unreadable event and keeps the rest of the calendar', () => {
    const { events } = decodeIcs(
      calendar(
        'BEGIN:VEVENT',
        'UID:broken@example.invalid',
        'SUMMARY:No start at all',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:fine@example.invalid',
        'SUMMARY:Fine',
        'DTSTART:20260311T090000Z',
        'DTEND:20260311T100000Z',
        'END:VEVENT',
      ),
      window(),
    )
    expect(events.map((e) => e.summary)).toEqual(['Fine'])
  })

  it('returns an empty calendar rather than failing', () => {
    expect(decodeIcs(calendar(), window())).toEqual({ events: [], count: 0 })
  })

  it('refuses a body that is not iCalendar', () => {
    expect(() => decodeIcs('<html>login</html>', window())).toThrow(IcsParseError)
  })

  it('sorts the result chronologically regardless of file order', () => {
    const { events } = decodeIcs(
      calendar(
        'BEGIN:VEVENT',
        'UID:2@example.invalid',
        'SUMMARY:Second',
        'DTSTART:20260320T090000Z',
        'DTEND:20260320T100000Z',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:1@example.invalid',
        'SUMMARY:First',
        'DTSTART:20260311T090000Z',
        'DTEND:20260311T100000Z',
        'END:VEVENT',
      ),
      window(),
    )
    expect(events.map((e) => e.summary)).toEqual(['First', 'Second'])
  })
})

describe('through the decoder registry', () => {
  it('is reachable as the ics kind', () => {
    const decoded = decode(
      'ics',
      calendar(
        'BEGIN:VEVENT',
        'UID:z@example.invalid',
        'SUMMARY:Via registry',
        'DTSTART:20260311T090000Z',
        'DTEND:20260311T100000Z',
        'END:VEVENT',
      ),
      { now: NOW },
    )
    expect(decoded).toMatchObject({ events: [{ summary: 'Via registry' }] })
  })

  it('reports a parse failure with a code and no upstream text', () => {
    try {
      decode('ics', 'not a calendar', { now: NOW })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(DecodeError)
      expect((error as DecodeError).code).toBe('bad-ics')
      expect((error as DecodeError).message).not.toContain('not a calendar')
    }
  })
})
