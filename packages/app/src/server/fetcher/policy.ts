import { BlockList, isIP } from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'

/**
 * Egress policy: which addresses the app may connect to, and pinned resolution so the answer cannot
 * change between check and connect. RFC1918 is allowed on purpose (the displayed services live on
 * the LAN); only ranges that are never a homelab service are blocked.
 */

export class BlockedAddressError extends Error {
  readonly address: string
  readonly reason: string

  constructor(address: string, reason: string) {
    super(`refusing to connect to ${address}: ${reason}`)
    this.name = 'BlockedAddressError'
    this.address = address
    this.reason = reason
  }
}

export class InvalidTargetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidTargetError'
  }
}

function buildBlockList(allowLoopback: boolean): BlockList {
  const list = new BlockList()

  // Cloud metadata and link-local.
  list.addAddress('169.254.169.254', 'ipv4')
  list.addSubnet('169.254.0.0', 16, 'ipv4')
  list.addSubnet('fe80::', 10, 'ipv6')

  // "This host on this network" — 0.0.0.0/8 reaches localhost on Linux.
  list.addSubnet('0.0.0.0', 8, 'ipv4')
  list.addAddress('::', 'ipv6')

  // Multicast and broadcast.
  list.addSubnet('224.0.0.0', 4, 'ipv4')
  list.addSubnet('ff00::', 8, 'ipv6')
  list.addAddress('255.255.255.255', 'ipv4')

  // Carrier-grade NAT.
  list.addSubnet('100.64.0.0', 10, 'ipv4')

  if (!allowLoopback) {
    list.addSubnet('127.0.0.0', 8, 'ipv4')
    list.addAddress('::1', 'ipv6')
  }
  return list
}

/**
 * Unwraps IPv4-mapped IPv6 (`::ffff:127.0.0.1`): BlockList.check with the wrong family silently
 * returns false.
 */
function normaliseAddress(address: string): { canonical: string; family: 'ipv4' | 'ipv6' } | null {
  const version = isIP(address)
  if (version === 4) return { canonical: address, family: 'ipv4' }
  if (version !== 6) return null

  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)
  if (mapped?.[1] !== undefined && isIP(mapped[1]) === 4) {
    return { canonical: mapped[1], family: 'ipv4' }
  }
  return { canonical: address, family: 'ipv6' }
}

/** A host the user named as this machine; lifts the loopback block for that target only. */
export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost'
}

export type PolicyOptions = {
  /** Set only for a service the user has explicitly said is on this machine. */
  readonly allowLoopback?: boolean
}

export function assertAddressAllowed(address: string, options: PolicyOptions = {}): void {
  const normalised = normaliseAddress(address)
  if (normalised === null) {
    // Only reachable if the resolver returned a non-literal; refuse rather than pass it on.
    throw new BlockedAddressError(address, 'not a canonical IP address')
  }
  const list = buildBlockList(options.allowLoopback ?? false)
  if (list.check(normalised.canonical, normalised.family)) {
    throw new BlockedAddressError(address, 'address is in a range this app never connects to')
  }
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

/**
 * Write-time shape check of a config URL; not a security control, since `getaddrinfo` accepts
 * encodings `BlockList` does not.
 */
export function assertUrlShape(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new InvalidTargetError(`not a valid URL: ${raw}`)
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new InvalidTargetError(`only http and https are supported, got ${url.protocol}`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new InvalidTargetError('credentials in the URL are not supported; use a secret field')
  }
  if (url.hash !== '') {
    throw new InvalidTargetError('a fragment in a target URL is never meaningful and hides a path')
  }
  const host = url.hostname
  if (isIP(host) === 0) assertHostnameShape(host)
  return url
}

const LABEL = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/

/**
 * Refuses a numeric or hex final label: `2852039166`, `0177.0.0.1`, `127.1` and `0x7f.1` all
 * resolve to loopback through getaddrinfo, and BlockList returns false for every one of them.
 */
export function assertHostnameShape(host: string): void {
  const labels = host.split('.')
  if (labels.length === 0 || labels.some((label) => !LABEL.test(label))) {
    throw new InvalidTargetError(`host is neither a hostname nor a canonical IP literal: ${host}`)
  }
  const last = labels[labels.length - 1] as string
  if (/^[0-9]+$/.test(last) || /^0[xX]/.test(last)) {
    throw new InvalidTargetError(
      `host "${host}" looks like an encoded IP address, not a hostname; ` +
        'write the address in its normal dotted form',
    )
  }
}

export type ResolvedHost = {
  readonly hostname: string
  readonly addresses: readonly { address: string; family: 4 | 6 }[]
}

/** Resolves a hostname and checks every address returned; which one is dialled is up to the OS. */
export async function resolveAndCheck(
  hostname: string,
  options: PolicyOptions = {},
): Promise<ResolvedHost> {
  const literal = normaliseAddress(hostname)
  if (literal !== null) {
    assertAddressAllowed(hostname, options)
    return {
      hostname,
      addresses: [{ address: literal.canonical, family: literal.family === 'ipv4' ? 4 : 6 }],
    }
  }

  const results = await dnsLookup(hostname, { all: true, verbatim: true })
  if (results.length === 0) throw new InvalidTargetError(`${hostname} did not resolve`)
  for (const entry of results) assertAddressAllowed(entry.address, options)
  return {
    hostname,
    addresses: results.map((r) => ({ address: r.address, family: r.family as 4 | 6 })),
  }
}

export type LookupCallback = (
  error: Error | null,
  addressOrList?: string | { address: string; family: number }[],
  family?: number,
) => void

/**
 * A `lookup` that returns only the pre-checked addresses, closing DNS rebinding. Must branch on
 * `options.all`: Node's HTTP layer passes `{all: true}` and rejects the three-argument callback
 * form with "Invalid IP address: undefined".
 */
export function pinnedLookup(resolved: ResolvedHost) {
  return (
    _hostname: string,
    options: { all?: boolean; family?: number },
    callback: LookupCallback,
  ): void => {
    const wanted =
      options.family === 4 || options.family === 6
        ? resolved.addresses.filter((a) => a.family === options.family)
        : resolved.addresses
    const usable = wanted.length > 0 ? wanted : resolved.addresses

    if (options.all === true) {
      callback(
        null,
        usable.map((a) => ({ address: a.address, family: a.family })),
      )
      return
    }
    const first = usable[0]
    if (first === undefined) {
      callback(new Error(`no allowed address for ${resolved.hostname}`))
      return
    }
    callback(null, first.address, first.family)
  }
}
