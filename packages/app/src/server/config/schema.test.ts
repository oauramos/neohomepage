import { describe, expect, it } from 'vitest'
import { targetSchema } from './schema.ts'

const target = (basePath: string) =>
  targetSchema.safeParse({
    id: 't1',
    label: 'Feed',
    widgetType: 'ics-feed',
    base: { scheme: 'https', host: 'calendar.google.com', port: 443, basePath },
  })

describe('a target base path', () => {
  it('accepts a Google Calendar private feed, escapes and all', () => {
    expect(target('/calendar/ical/someone%40gmail.com/private-0123abcd/basic.ics').success).toBe(
      true,
    )
  })

  it('still refuses traversal and characters that are not a path', () => {
    for (const bad of ['/a/../b', '/a b', '/a?x=1', '/a%zz', 'relative']) {
      expect(target(bad).success, bad).toBe(false)
    }
  })
})
