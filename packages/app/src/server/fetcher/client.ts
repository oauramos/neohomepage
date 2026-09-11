import { isIP, type LookupFunction } from 'node:net'
import { Agent, request } from 'undici'
import { pinnedLookup, resolveAndCheck, type PolicyOptions } from './policy.ts'

/**
 * The upstream HTTP client.
 *
 * Every constraint here exists because of a specific way a dashboard that proxies user-configured
 * endpoints has been broken before, in this product's own predecessor.
 */

export type FetchLimits = {
  /** Abort the body at this size. One misconfigured target returning a 500 MB response is
   *  otherwise an instant OOM on a 1 GB box. */
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
  /** A stable code. Never a URL and never an upstream message: verbose errors have leaked API
   *  keys from a dashboard before, and this string reaches the browser. */
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
}

export type UpstreamResponse = {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
  readonly truncated: boolean
}

async function readCapped(
  body: AsyncIterable<Buffer>,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of body) {
    total += chunk.length
    if (total > maxBytes) {
      // Keep the prefix so a decoder can still report something useful, then stop reading. The
      // remote end is disconnected by leaving the iterator.
      chunks.push(chunk.subarray(0, chunk.length - (total - maxBytes)))
      return { text: Buffer.concat(chunks).toString('utf8'), truncated: true }
    }
    chunks.push(chunk)
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated: false }
}

/**
 * Perform one upstream request.
 *
 * The hostname is resolved and checked ONCE, then the connection is pinned to those addresses.
 * Redirects are surfaced, never followed: no LAN service API needs a redirect, and following one
 * reopens the whole validate-then-redirect bypass class — the exact bug that broke gethomepage's
 * first SSRF fix within hours of shipping it.
 */
export async function fetchUpstream(input: UpstreamRequest): Promise<UpstreamResponse> {
  const limits = { ...DEFAULT_FETCH_LIMITS, ...input.limits }
  const policy: PolicyOptions = { allowLoopback: input.allowLoopback ?? false }
  const resolved = await resolveAndCheck(input.url.hostname, policy)

  const agent = new Agent({
    connect: {
      // Cast: Node's LookupFunction type only describes the three-argument callback, while the
      // HTTP layer actually calls it with {all: true} and requires the array form. The runtime
      // contract is covered by policy.test.ts, which exercises both shapes.
      lookup: pinnedLookup(resolved) as unknown as LookupFunction,
      timeout: limits.connectTimeoutMs,
      rejectUnauthorized: input.insecureSkipVerify !== true,
      // SNI and virtual hosts still work: the name travels, only the address is pinned. Only a
      // NAME travels, though — Node refuses an IP literal as the TLS ServerName, and the refusal
      // is thrown while the socket is being set up, so `https://192.168.1.10:8006` (which is how
      // every Proxmox, Portainer and TrueNAS on a LAN is addressed) came back "unreachable" before
      // a packet was sent. Node's own https module makes the same distinction.
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
      // No redirect interceptor is composed onto the agent, so undici does not follow redirects.
      // That is the intent: a 3xx is surfaced below as an actionable error.
      signal: abort,
    })

    if (response.statusCode >= 300 && response.statusCode < 400) {
      // dump() drains and discards; destroy() emits UND_ERR_ABORTED as an unhandled rejection,
      // which surfaces as a spurious error long after the request has been dealt with.
      await response.body.dump()
      throw new UpstreamError(
        'redirect',
        'the target redirected; no LAN service API should, so update the saved URL instead',
      )
    }

    const { text, truncated } = await readCapped(response.body, limits.maxBodyBytes)
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(response.headers)) {
      if (typeof value === 'string') headers[key.toLowerCase()] = value
    }
    return { status: response.statusCode, headers, body: text, truncated }
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
