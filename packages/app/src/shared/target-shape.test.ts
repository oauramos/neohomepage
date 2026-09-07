import { describe, expect, it } from 'vitest'
import { manifestSchema, type Manifest } from '@neohomepage/catalog-schema'
import { routeValues, targetShapeFields } from './target-shape.ts'

const single = manifestSchema.parse({
  manifestVersion: 1,
  id: 'sonarr-queue',
  version: '1.0.0',
  displayName: 'Sonarr',
  category: 'media',
  icon: 'sonarr',
  target: {
    fields: [
      { name: 'apiKey', kind: 'secret', label: 'API key', required: true },
      { name: 'username', kind: 'string', label: 'Username' },
    ],
    auth: { kind: 'header', header: 'X-Api-Key', value: '{{secret:apiKey}}' },
  },
  config: [],
  operations: { queue: { method: 'GET', path: '/api/v3/queue', decode: 'json' } },
  projection: { op: 'get', path: '$' },
  presentation: { template: 'list' },
  poll: { defaultIntervalMs: 60_000, minIntervalMs: 15_000 },
  requires: { templates: ['list'], opcodes: ['get'], authKinds: ['header'], fetchKinds: ['json'] },
})

const composite = manifestSchema.parse({
  manifestVersion: 1,
  id: 'agenda',
  version: '1.0.0',
  displayName: 'Agenda',
  category: 'information',
  icon: 'calendar',
  config: [],
  roles: {
    calendars: {
      label: 'Calendars',
      kinds: {
        'ics-feed': {
          label: 'iCalendar',
          fields: [],
          auth: { kind: 'none' },
          operation: { method: 'GET', path: '/', decode: 'ics' },
          emits: [{ id: 'events', label: 'Events', projection: { op: 'get', path: '$.events' } }],
        },
        'caldav-feed': {
          label: 'CalDAV',
          fields: [{ name: 'password', kind: 'secret', label: 'Password', required: true }],
          auth: { kind: 'basic', username: 'x', password: '{{secret:password}}' },
          operation: { method: 'GET', path: '/', decode: 'ics' },
          emits: [{ id: 'events', label: 'Events', projection: { op: 'get', path: '$.events' } }],
        },
      },
    },
  },
  compose: { limit: 20 },
  presentation: { template: 'list' },
  poll: { defaultIntervalMs: 900_000, minIntervalMs: 300_000 },
  requires: {
    templates: ['list'],
    opcodes: ['get'],
    authKinds: ['basic', 'none'],
    fetchKinds: ['ics'],
  },
})

const catalog: ReadonlyMap<string, Manifest> = new Map([
  ['sonarr-queue', single],
  ['agenda', composite],
])

describe('resolving a target shape', () => {
  it('finds a single-source manifest by id', () => {
    expect(targetShapeFields(catalog, 'sonarr-queue')?.map((f) => f.name)).toEqual([
      'apiKey',
      'username',
    ])
  })

  it('finds a source kind that exists only inside a composite', () => {
    // A calendar's CalDAV binding is a target shaped like `caldav-feed`, which is not a catalog
    // entry of its own. Without this the server could not tell that its password is a credential.
    expect(targetShapeFields(catalog, 'caldav-feed')?.map((f) => f.name)).toEqual(['password'])
    expect(targetShapeFields(catalog, 'ics-feed')).toEqual([])
  })

  it('returns null for a shape nothing declares', () => {
    expect(targetShapeFields(catalog, 'invented')).toBeNull()
  })
})

describe('routing values', () => {
  const fields = targetShapeFields(catalog, 'sonarr-queue') ?? []

  it('sends a declared secret to the vault and the rest to config', () => {
    expect(routeValues(fields, { values: { apiKey: 'SECRET', username: 'otavio' } })).toEqual({
      fields: { username: 'otavio' },
      secrets: { apiKey: 'SECRET' },
      unknown: [],
    })
  })

  it('stores a credential as a secret even when the caller called it a plain field', () => {
    // The bug this exists to prevent, exactly: the browser used to decide the split, and a form
    // that got it wrong wrote an API key into config/targets/*.json in plaintext — into the
    // directory whose entire purpose is being committed to git.
    const routed = routeValues(fields, { fields: { apiKey: 'SECRET' } })
    expect(routed.secrets).toEqual({ apiKey: 'SECRET' })
    expect(routed.fields).toEqual({})
    expect(JSON.stringify(routed.fields)).not.toContain('SECRET')
  })

  it('drops anything the manifest does not declare, and says which', () => {
    const routed = routeValues(fields, { values: { apiKey: 'S', uid: 's0', test: 'whatever' } })
    expect(routed.fields).toEqual({})
    expect([...routed.unknown].sort()).toEqual(['test', 'uid'])
  })

  it('honours the caller buckets when no manifest can speak for the shape', () => {
    // A hand-made `custom` target has no shape in the catalog. Discarding its credential would
    // leave an unexplained "credential unavailable"; the property that matters — a DECLARED
    // secret cannot reach config — is unaffected, because there is nothing declared.
    expect(routeValues(null, { secrets: { token: 'SECRET' }, fields: { host: 'nas' } })).toEqual({
      fields: { host: 'nas' },
      secrets: { token: 'SECRET' },
      unknown: [],
    })
  })

  it('refuses to guess at an unclassified bag when the shape is unknown', () => {
    // Writing it to config might commit a credential; writing it to the vault might hide a
    // hostname. Neither, and say so.
    const routed = routeValues(null, { values: { apiKey: 'SECRET', host: 'nas' } })
    expect(routed.fields).toEqual({})
    expect(routed.secrets).toEqual({})
    expect([...routed.unknown].sort()).toEqual(['apiKey', 'host'])
  })

  it('skips null and undefined instead of writing them', () => {
    expect(routeValues(fields, { values: { apiKey: null, username: undefined } })).toEqual({
      fields: {},
      secrets: {},
      unknown: [],
    })
  })
})
