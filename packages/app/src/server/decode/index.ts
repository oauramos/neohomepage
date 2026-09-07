import type { Decoder } from '@neohomepage/catalog-schema'
import type { Json } from '@neohomepage/catalog-schema'

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

export function decode(kind: Decoder, body: string): Json {
  switch (kind) {
    case 'json':
      return decodeJson(body)
    case 'text':
      return decodeText(body)
    case 'ics':
      // Deliberately explicit rather than silently returning the raw text, which would produce a
      // widget that renders an unparsed VCALENDAR blob and no error. Lands with the calendar.
      throw new DecodeError('unsupported-decoder', 'the ics decoder is not available in this build')
    default: {
      const exhaustive: never = kind
      throw new DecodeError('unknown-decoder', `unknown decoder ${String(exhaustive)}`)
    }
  }
}

/** Decoders this build supports, for the catalog's capability check. */
export const SUPPORTED_DECODERS: readonly Decoder[] = ['json', 'text']
