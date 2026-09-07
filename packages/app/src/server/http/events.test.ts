import { describe, expect, it } from 'vitest'
import { EventHub, formatEvent, KEEPALIVE_FRAME } from './events.ts'

function recorder() {
  const sent: string[] = []
  let closed = false
  return {
    sent,
    get closed() {
      return closed
    },
    subscriber: {
      send: (event: { type: string; data: unknown }) =>
        sent.push(`${event.type}:${JSON.stringify(event.data)}`),
      close: () => {
        closed = true
      },
    },
  }
}

describe('broadcast', () => {
  it('delivers to every subscriber', () => {
    const hub = new EventHub()
    const a = recorder()
    const b = recorder()
    hub.add(a.subscriber)
    hub.add(b.subscriber)

    expect(hub.broadcast({ type: 'widget', data: { id: 'w1' } })).toBe(2)
    expect(a.sent).toEqual(['widget:{"id":"w1"}'])
    expect(b.sent).toEqual(['widget:{"id":"w1"}'])
  })

  it('stops delivering once a subscriber releases', () => {
    const hub = new EventHub()
    const a = recorder()
    const { release } = hub.add(a.subscriber)
    release()
    expect(hub.broadcast({ type: 'widget', data: {} })).toBe(0)
    expect(hub.size).toBe(0)
  })

  it('drops a subscriber whose write throws rather than buffering for it', () => {
    // A phone that slept with the tab open is a slow consumer; buffering for it inflates RSS on
    // a box that has none to spare.
    const hub = new EventHub()
    let closed = false
    hub.add({
      send: () => {
        throw new Error('socket gone')
      },
      close: () => {
        closed = true
      },
    })
    const healthy = recorder()
    hub.add(healthy.subscriber)

    expect(hub.broadcast({ type: 'widget', data: {} })).toBe(1)
    expect(hub.size).toBe(1)
    expect(closed).toBe(true)
    expect(healthy.sent).toHaveLength(1)
  })

  it('reports capacity so a new connection can be refused instead of degrading everyone', () => {
    const hub = new EventHub({ maxClients: 2 })
    expect(hub.atCapacity).toBe(false)
    hub.add(recorder().subscriber)
    hub.add(recorder().subscriber)
    expect(hub.atCapacity).toBe(true)
  })

  it('closes everything on shutdown', () => {
    const hub = new EventHub()
    const a = recorder()
    hub.add(a.subscriber)
    hub.closeAll()
    expect(a.closed).toBe(true)
    expect(hub.size).toBe(0)
  })
})

describe('the wire format', () => {
  it('emits an event name and a data line', () => {
    expect(formatEvent({ type: 'widget', data: { id: 'w1' } })).toBe(
      'event: widget\ndata: {"id":"w1"}\n\n',
    )
  })

  it('never emits a raw newline inside a frame, whatever the payload contains', () => {
    // An unprefixed continuation line silently truncates the frame at the receiver, and the
    // symptom is "some updates just never arrive". JSON.stringify escapes newlines rather
    // than emitting them, so this holds by construction — asserting it is what stops a future
    // change to a non-JSON encoder from breaking it quietly.
    const payloads: unknown[] = ['line one\nline two', { note: 'a\nb' }, ['x\ny'], 'crlf\r\nhere']
    for (const payload of payloads) {
      const frame = formatEvent({ type: 'widget', data: payload })
      const lines = frame.trimEnd().split('\n')
      expect(lines).toHaveLength(2)
      expect(lines[0]).toBe('event: widget')
      expect(lines[1]?.startsWith('data: ')).toBe(true)
    }
  })

  it('ends every frame with a blank line, which is what makes the receiver dispatch it', () => {
    expect(formatEvent({ type: 'hello', data: {} }).endsWith('\n\n')).toBe(true)
  })

  it('sends keepalive as a comment, so it costs a receiver nothing', () => {
    expect(KEEPALIVE_FRAME.startsWith(':')).toBe(true)
    expect(KEEPALIVE_FRAME.endsWith('\n\n')).toBe(true)
  })
})
