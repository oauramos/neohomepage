import type { Decoder } from '@neohomepage/catalog-schema'
import type { Json } from '@neohomepage/catalog-schema'
import { decodeIcs, DEFAULT_ICS_WINDOW, IcsParseError } from './ics.ts'

/**
 * Decoders run server-side, before the projection DSL ever sees data.
 *
 * The DSL operates on JSON. Anything that is not JSON on the wire — iCalendar, a Prometheus text
 * exposition — is normalised here, in one swappable file per format, rather than by growing the
 * DSL a parser it would then have to keep total and terminating.
 */

export class DecodeError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'DecodeError'
    this.code = code
  }
}

function decodeJson(body: string): Json {
  if (body.trim() === '') return null
  try {
    return JSON.parse(body) as Json
  } catch (error) {
    // The upstream message is never included: it can echo request content, and this reaches the
    // browser. The code is what a widget shows.
    throw new DecodeError('bad-json', 'the target did not return valid JSON', { cause: error })
  }
}

function decodeText(body: string): Json {
  return body
}

/**
 * What a decoder needs beyond the bytes.
 *
 * `now` is threaded from the request rather than read here so decoding stays a pure function of
 * its inputs: recurrence expansion needs a window, and a window anchored on a wall-clock read
 * would make the same calendar decode differently in a test than in production.
 */
export type DecodeContext = { readonly now: string }

export function decode(kind: Decoder, body: string, context: DecodeContext): Json {
  switch (kind) {
    case 'json':
      return decodeJson(body)
    case 'text':
      return decodeText(body)
    case 'ics':
      return decodeIcalendar(body, context)
    default: {
      const exhaustive: never = kind
      throw new DecodeError('unknown-decoder', `unknown decoder ${String(exhaustive)}`)
    }
  }
}

function decodeIcalendar(body: string, context: DecodeContext): Json {
  try {
    return decodeIcs(body, { now: context.now, ...DEFAULT_ICS_WINDOW }) as unknown as Json
  } catch (error) {
    if (error instanceof IcsParseError) {
      throw new DecodeError('bad-ics', 'the target did not return valid iCalendar data', {
        cause: error,
      })
    }
    throw error
  }
}

/** Decoders this build supports, for the catalog's capability check. */
export const SUPPORTED_DECODERS: readonly Decoder[] = ['ics', 'json', 'text']
