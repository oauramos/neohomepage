import { BlockList, isIP } from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'

/**
 * The egress policy: which addresses this app is allowed to talk to, and how a hostname is
 * resolved so the answer cannot change between the check and the connection.
 *
 * The posture is unusual and deliberate: **RFC1918 is allowed**. Reaching 192.168.x.x is the
 * entire product — the services being displayed live there. A generic "block private ranges" SSRF
 * filter would break everything and protect nothing here. What is blocked is the set of addresses
 * that are never a homelab service and are always an escalation: cloud metadata, link-local,
 * loopback (unless explicitly allowed for a local service), multicast and the unspecified address.
 *
 * Two findings this module is built around, both verified rather than assumed:
 *
 *  - `BlockList.check('::ffff:127.0.0.1', 'ipv4')` returns **false**. Passing a hardcoded family
 *    fails OPEN for IPv4-mapped IPv6 addresses. The family is derived per address instead.
 *
 *  - `BlockList.check()` returns false (it does not throw) for non-canonical host strings like
 *    `2852039166` or `0177.0.0.1`, which `getaddrinfo` resolves to 127.0.0.1 quite happily. So a
 *    check on a user-typed host is not defence in depth, it is a false sense of safety. Only the
 *    post-DNS check on canonical output means anything.
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

  // The one that turns an SSRF into cloud credentials.
  list.addAddress('169.254.169.254', 'ipv4')
  list.addSubnet('169.254.0.0', 16, 'ipv4')
  list.addSubnet('fe80::', 10, 'ipv6')

  // "This host on this network" — 0.0.0.0/8 reaches localhost on Linux.
  list.addSubnet('0.0.0.0', 8, 'ipv4')
  list.addAddress('::', 'ipv6')

  // Multicast and broadcast are never a service you configured.
  list.addSubnet('224.0.0.0', 4, 'ipv4')
  list.addSubnet('ff00::', 8, 'ipv6')
  list.addAddress('255.255.255.255', 'ipv4')

  // Carrier-grade NAT and documentation ranges: not reachable, and used in SSRF probes.
  list.addSubnet('100.64.0.0', 10, 'ipv4')

  if (!allowLoopback) {
    list.addSubnet('127.0.0.0', 8, 'ipv4')
    list.addAddress('::1', 'ipv6')
  }
  return list
}

/**
 * IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is the same host as `127.0.0.1`, but a v6 literal. Both
 * forms are checked, because a list populated with v4 subnets does not match the mapped form and
 * a check with the wrong family silently returns false.
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

export type PolicyOptions = {
  /** Set only for a service the user has explicitly said is on this machine. */
  readonly allowLoopback?: boolean
}

/** Throws for an address this app must never connect to. */
export function assertAddressAllowed(address: string, options: PolicyOptions = {}): void {
  const normalised = normaliseAddress(address)
  if (normalised === null) {
    // Reached only if DNS returned something that is not an IP literal, which would be a bug in
    // the resolver rather than in the config — refuse rather than pass it to the socket layer.
    throw new BlockedAddressError(address, 'not a canonical IP address')
  }
  const list = buildBlockList(options.allowLoopback ?? false)
  if (list.check(normalised.canonical, normalised.family)) {
    throw new BlockedAddressError(address, 'address is in a range this app never connects to')
  }
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

/**
 * Validate a URL the *config* supplied. This runs at write time and is about shape, not safety —
 * see the note at the top: a host string check cannot be a security control, because
 * `getaddrinfo` accepts encodings `BlockList` does not.
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
    // Credentials in a URL end up in logs and history. They belong in the secret vault.
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
 * A hostname whose final label is entirely numeric is not a hostname — it is an IP address in an
 * encoding `isIP` does not recognise. `2852039166`, `0177.0.0.1`, `127.1` and `0x7f.1` all resolve
 * to loopback through getaddrinfo while sailing past a naive alphanumeric check, and BlockList
 * returns false for every one of them rather than throwing.
 *
 * Requiring a non-numeric final label is the same rule that separates hostnames from address
 * literals everywhere else, and no real hostname violates it.
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

/**
 * Resolve a hostname and check every address it returned.
 *
 * Checking every address rather than the first matters: a name that resolves to both a real LAN
 * address and 169.254.169.254 would otherwise be allowed, and which one the connection actually
 * used would be up to the OS.
 */
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
 * A `lookup` implementation that returns only pre-checked addresses.
 *
 * This is what closes DNS rebinding: the name is resolved once, every answer is checked, and the
 * connection is then pinned to those addresses so there is no second resolution to poison.
 *
 * It MUST branch on `options.all`. Node passes `{all: true}` from the HTTP layer and then rejects
 * the three-argument callback form with "Invalid IP address: undefined" — the lookup is called,
 * it just cannot succeed. The failure mode is "every widget errors", which someone under pressure
 * fixes by deleting the custom lookup, taking the rebinding defence with it.
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
