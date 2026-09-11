import { describe, expect, it } from 'vitest'
import {
  auditManifest,
  compositeManifestSchema,
  deriveRequires,
  isComposite,
  manifestSchema,
  sourceKinds,
} from './manifest.ts'

/** A two-kind composite: one JSON source with a header key, one ICS feed with no auth. */
const base = () => ({
  manifestVersion: 1,
  id: 'agenda',
  version: '1.0.0',
  displayName: 'Agenda',
  category: 'information',
  icon: 'calendar',
  config: [],
  presentation: { template: 'list' },
  poll: { defaultIntervalMs: 300_000, minIntervalMs: 60_000 },
  roles: {
    calendars: {
      label: 'Calendars',
      min: 1,
      max: 8,
      kinds: {
        sonarr: {
          label: 'Sonarr',
          fields: [{ name: 'apiKey', kind: 'secret', label: 'API key', required: true }],
          auth: { kind: 'header', header: 'X-Api-Key', value: '{{secret:apiKey}}' },
          operation: { method: 'GET', path: '/api/v3/calendar', decode: 'json' },
          emits: [
            {
              id: 'airing',
              label: 'Airing',
              projection: {
                op: 'map',
                as: 'e',
                over: { op: 'get', path: '$.records' },
                body: { op: 'pick', fields: { title: { op: 'get', path: 'e.title' } } },
              },
            },
          ],
        },
        ics: {
          label: 'iCalendar feed',
          fields: [],
          auth: { kind: 'none' },
          operation: { method: 'GET', path: '/calendar.ics', decode: 'ics' },
          emits: [
            {
              id: 'events',
              label: 'Events',
              projection: {
                op: 'map',
                as: 'e',
                over: { op: 'get', path: '$.events' },
                body: { op: 'pick', fields: { title: { op: 'get', path: 'e.summary' } } },
              },
            },
          ],
        },
      },
    },
  },
  compose: { sortBy: [{ path: 'badge.iso', direction: 'asc' }], limit: 15 },
  requires: {
    templates: ['list'],
    opcodes: ['get', 'map', 'pick'],
    authKinds: ['header', 'none'],
    fetchKinds: ['ics', 'json'],
  },
})

describe('the two manifest shapes', () => {
  it('parses a composite through the union and narrows on roles', () => {
    const manifest = manifestSchema.parse(base())
    expect(isComposite(manifest)).toBe(true)
    if (!isComposite(manifest)) throw new Error('unreachable')
    expect(Object.keys(manifest.roles)).toEqual(['calendars'])
  })

  it('refuses a manifest that is neither shape', () => {
    const { roles, compose, ...neither } = base()
    void roles
    void compose
    expect(manifestSchema.safeParse(neither).success).toBe(false)
  })

  it('refuses a manifest that is both shapes at once', () => {
    // Both branches are strict, so a mixed manifest fails instead of half of it going unread.
    const both = { ...base(), target: { fields: [], auth: { kind: 'none' } }, operations: {} }
    expect(manifestSchema.safeParse(both).success).toBe(false)
  })

  it('flattens every kind with the role it belongs to', () => {
    const manifest = compositeManifestSchema.parse(base())
    expect(sourceKinds(manifest).map((entry) => `${entry.role}/${entry.kind}`)).toEqual([
      'calendars/sonarr',
      'calendars/ics',
    ])
  })
})

describe('derived requirements', () => {
  it('unions the auth kinds, decoders and opcodes over every source', () => {
    expect(deriveRequires(compositeManifestSchema.parse(base()))).toEqual({
      templates: ['list'],
      opcodes: ['get', 'map', 'pick'],
      authKinds: ['header', 'none'],
      fetchKinds: ['ics', 'json'],
    })
  })

  it('catches a declared block that understates what a source needs', () => {
    const understated = base()
    understated.requires.fetchKinds = ['json']
    const problems = auditManifest(manifestSchema.parse(understated))
    expect(problems.map((p) => p.path)).toContain('requires.fetchKinds')
  })
})

describe('the audit applies to every source, not just the first', () => {
  it('catches a secret referenced by a later source but never declared', () => {
    const manifest = base()
    manifest.roles.calendars.kinds.ics.auth = {
      kind: 'header',
      header: 'Authorization',
      value: '{{secret:token}}',
    } as never
    manifest.requires.authKinds = ['header']
    const problems = auditManifest(manifestSchema.parse(manifest))
    expect(problems.map((p) => p.message)).toContain('references undeclared secret token')
  })

  it('catches a secret smuggled into a path template', () => {
    const manifest = base()
    manifest.roles.calendars.kinds.sonarr.operation.path = '/api/{{secret:apiKey}}/calendar'
    const problems = auditManifest(manifestSchema.parse(manifest))
    expect(problems.map((p) => p.path)).toContain('roles.calendars.kinds.sonarr.operation')
  })

  it('catches duplicate emit ids, which would silently double a stream', () => {
    const manifest = base()
    const emits = manifest.roles.calendars.kinds.sonarr.emits
    emits.push({ ...emits[0]! })
    const problems = auditManifest(manifestSchema.parse(manifest))
    expect(problems.map((p) => p.message)).toContain('duplicate emit id airing')
  })

  it('catches a sort key that addresses nothing an item has', () => {
    const manifest = base()
    manifest.compose.sortBy = [{ path: 'startsAt', direction: 'asc' }]
    const problems = auditManifest(manifestSchema.parse(manifest))
    expect(problems.map((p) => p.path)).toContain('compose.sortBy')
  })

  it('accepts a nested path into a field an item does have', () => {
    expect(auditManifest(manifestSchema.parse(base()))).toEqual([])
  })

  it('catches a role that can never be satisfied', () => {
    const manifest = base()
    manifest.roles.calendars.min = 4
    manifest.roles.calendars.max = 2
    const problems = auditManifest(manifestSchema.parse(manifest))
    expect(problems.map((p) => p.message)).toContain('min 4 exceeds max 2')
  })
})
