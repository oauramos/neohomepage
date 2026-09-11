import { isIP, type LookupFunction } from 'node:net'
import { Agent, request } from 'undici'
import { pinnedLookup, resolveAndCheck, type PolicyOptions } from './policy.ts'

export type FetchLimits = {
  /** The body is cut here and marked truncated rather than buffered. */
  readonly maxBodyBytes: number
  readonly connectTimeoutMs: number
  readonly headersTimeoutMs: number
  readonly bodyTimeoutMs: number
  readonly totalTimeoutMs: number
}

export const DEFAULT_FETCH_LIMITS: FetchLimits = {
  maxBodyBytes: 1024 * 1024,
  connectTimeoutMs: 2_000,
  headersTimeoutMs: 5_000,
  bodyTimeoutMs: 10_000,
  totalTimeoutMs: 15_000,
}

export class UpstreamError extends Error {
  /** Stable code; never a URL or an upstream message, since it reaches the browser. */
  readonly code: string

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'UpstreamError'
    this.code = code
  }
}

export type UpstreamRequest = {
  readonly url: URL
  readonly method: 'GET' | 'POST'
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
  readonly allowLoopback?: boolean
  readonly insecureSkipVerify?: boolean
  readonly limits?: Partial<FetchLimits>
  /** Keep the response as bytes rather than decoding it as UTF-8 text. */
  readonly binary?: boolean
}

export type UpstreamResponse = {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
  /** Present only for a `binary` request; `body` is then empty. */
  readonly bytes?: Uint8Array
  readonly truncated: boolean
}

async function readCapped(
  body: AsyncIterable<Buffer>,
  maxBytes: number,
): Promise<{ bytes: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of body) {
    total += chunk.length
    if (total > maxBytes) {
      // Returning from the loop closes the iterator, which disconnects the remote end.
      chunks.push(chunk.subarray(0, chunk.length - (total - maxBytes)))
      return { bytes: Buffer.concat(chunks), truncated: true }
    }
    chunks.push(chunk)
  }
  return { bytes: Buffer.concat(chunks), truncated: false }
}

/**
 * The hostname is resolved and checked once, then the connection is pinned to those addresses.
 * Redirects are surfaced, never followed: following one reopens the validate-then-redirect SSRF
 * bypass.
 */
export async function fetchUpstream(input: UpstreamRequest): Promise<UpstreamResponse> {
  const limits = { ...DEFAULT_FETCH_LIMITS, ...input.limits }
  const policy: PolicyOptions = { allowLoopback: input.allowLoopback ?? false }
  const resolved = await resolveAndCheck(input.url.hostname, policy)

  const agent = new Agent({
    connect: {
      // Cast: Node's LookupFunction type omits the {all: true} array form the HTTP layer calls.
      lookup: pinnedLookup(resolved) as unknown as LookupFunction,
      timeout: limits.connectTimeoutMs,
      rejectUnauthorized: input.insecureSkipVerify !== true,
      // Only the address is pinned; the name still travels for SNI. Node rejects an IP literal as
      // servername, so none is set for one.
      ...(isIP(resolved.hostname) === 0 ? { servername: resolved.hostname } : {}),
    },
    headersTimeout: limits.headersTimeoutMs,
    bodyTimeout: limits.bodyTimeoutMs,
    connections: 4,
    pipelining: 1,
  })

  const abort = AbortSignal.timeout(limits.totalTimeoutMs)
  try {
    const response = await request(input.url, {
      method: input.method,
      headers: { accept: 'application/json, text/plain;q=0.9, */*;q=0.5', ...input.headers },
      ...(input.body === undefined ? {} : { body: input.body }),
      dispatcher: agent,
      // No redirect interceptor on the agent, so undici does not follow redirects.
      signal: abort,
    })

    if (response.statusCode >= 300 && response.statusCode < 400) {
      // dump() drains; destroy() would emit UND_ERR_ABORTED as an unhandled rejection.
      await response.body.dump()
      throw new UpstreamError(
        'redirect',
        'the target redirected; no LAN service API should, so update the saved URL instead',
      )
    }

    const { bytes, truncated } = await readCapped(response.body, limits.maxBodyBytes)
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(response.headers)) {
      if (typeof value === 'string') headers[key.toLowerCase()] = value
    }
    return input.binary === true
      ? { status: response.statusCode, headers, body: '', bytes: new Uint8Array(bytes), truncated }
      : { status: response.statusCode, headers, body: bytes.toString('utf8'), truncated }
  } catch (error) {
    if (error instanceof UpstreamError) throw error
    const code = (error as { code?: string }).code
    if (abort.aborted || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') {
      throw new UpstreamError('timeout', 'the target did not answer in time', { cause: error })
    }
    if (code === 'ECONNREFUSED') {
      throw new UpstreamError('refused', 'the target refused the connection', { cause: error })
    }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      throw new UpstreamError('dns', 'the target hostname did not resolve', { cause: error })
    }
    if (
      code === 'CERT_HAS_EXPIRED' ||
      code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
      code === 'SELF_SIGNED_CERT_IN_CHAIN'
    ) {
      throw new UpstreamError(
        'tls',
        'the target presented a certificate that could not be verified',
        {
          cause: error,
        },
      )
    }
    throw new UpstreamError('unreachable', 'the target could not be reached', { cause: error })
  } finally {
    await agent.close().catch(() => {})
  }
}
