import type { Decoder, Json } from '@neohomepage/catalog-schema'
import { decodeIcs, DEFAULT_ICS_WINDOW, IcsParseError } from './ics.ts'

/**
 * Decoders normalise non-JSON bodies (iCalendar, ...) to JSON server-side, before the projection
 * DSL sees data.
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
    // The upstream message can echo request content and this reaches the browser; only the code
    // is shown.
    throw new DecodeError('bad-json', 'the target did not return valid JSON', { cause: error })
  }
}

function decodeText(body: string): Json {
  return body
}

/**
 * `now` comes from the request rather than a wall-clock read so decoding is a pure function of
 * its inputs.
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
    return decodeIcs(body, { now: context.now, ...DEFAULT_ICS_WINDOW })
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
