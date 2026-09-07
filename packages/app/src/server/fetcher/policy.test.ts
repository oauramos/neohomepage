import { describe, expect, it } from 'vitest'
import {
  assertAddressAllowed,
  assertHostnameShape,
  assertUrlShape,
  BlockedAddressError,
  InvalidTargetError,
  pinnedLookup,
  resolveAndCheck,
} from './policy.ts'

/**
 * This is the module the whole product's safety rests on, so the table is exhaustive rather than
 * representative. Every entry here is an address or an encoding that has been used to turn an
 * SSRF into something worse.
 */

describe('addresses that are always refused', () => {
  const blocked = [
    ['169.254.169.254', 'cloud metadata — the one that turns an SSRF into credentials'],
    ['169.254.1.1', 'link-local'],
    ['fe80::1', 'IPv6 link-local'],
    ['0.0.0.0', 'unspecified; reaches localhost on Linux'],
    ['0.1.2.3', 'inside 0.0.0.0/8'],
    ['::', 'IPv6 unspecified'],
    ['224.0.0.1', 'multicast'],
    ['ff02::1', 'IPv6 multicast'],
    ['255.255.255.255', 'broadcast'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['127.0.0.1', 'loopback, unless explicitly allowed'],
    ['::1', 'IPv6 loopback, unless explicitly allowed'],
  ] as const

  for (const [address, why] of blocked) {
    it(`refuses ${address} (${why})`, () => {
      expect(() => assertAddressAllowed(address)).toThrow(BlockedAddressError)
    })
  }

  it('refuses the IPv4-mapped form of a blocked address', () => {
    // BlockList.check('::ffff:127.0.0.1', 'ipv4') returns FALSE. Passing a hardcoded family fails
    // open here, so the family is derived per address and the mapped form is unwrapped first.
    expect(() => assertAddressAllowed('::ffff:127.0.0.1')).toThrow(BlockedAddressError)
    expect(() => assertAddressAllowed('::ffff:169.254.169.254')).toThrow(BlockedAddressError)
    expect(() => assertAddressAllowed('::FFFF:169.254.169.254')).toThrow(BlockedAddressError)
  })
})

describe('addresses that must keep working', () => {
  // Reaching these IS the product. A generic "block private ranges" filter would break everything
  // and protect nothing, because the services being displayed live on the LAN.
  const allowed = [
    '10.0.0.20',
    '192.168.1.50',
    '172.16.4.4',
    '172.31.255.254',
    '203.0.113.10',
    'fd00::1',
  ]

  for (const address of allowed) {
    it(`allows ${address}`, () => {
      expect(() => assertAddressAllowed(address)).not.toThrow()
    })
  }

  it('allows loopback only when a service is explicitly declared local', () => {
    expect(() => assertAddressAllowed('127.0.0.1', { allowLoopback: true })).not.toThrow()
    expect(() => assertAddressAllowed('::1', { allowLoopback: true })).not.toThrow()
  })
})

describe('URL shape', () => {
  it('accepts ordinary LAN targets', () => {
    expect(assertUrlShape('http://10.0.0.20:8989/').hostname).toBe('10.0.0.20')
    expect(assertUrlShape('https://sonarr.lan:443/base').hostname).toBe('sonarr.lan')
  })

  it('refuses non-HTTP schemes', () => {
    for (const url of ['file:///etc/passwd', 'gopher://x/', 'ftp://x/', 'data:text/plain,hi']) {
      expect(() => assertUrlShape(url), url).toThrow(InvalidTargetError)
    }
  })

  it('refuses credentials in the URL, which end up in logs and history', () => {
    expect(() => assertUrlShape('http://user:pass@10.0.0.20:8989/')).toThrow(
      /credentials in the URL/,
    )
  })

  it('refuses a fragment, which hides the real path from a reader', () => {
    expect(() => assertUrlShape('http://10.0.0.20:8989/api#/../admin')).toThrow(/fragment/)
  })

  it('normalises encoded IP hosts, so the address policy sees what will actually be dialled', () => {
    // The WHATWG URL parser decodes these itself — this was worth checking rather than assuming,
    // because it moves where the defence lives. `2852039166` is not an obscure string to
    // blocklist, it is literally 169.254.169.254, and after normalisation the ordinary address
    // check refuses it. BlockList.check() on the RAW string would have returned false.
    expect(assertUrlShape('http://2852039166/').hostname).toBe('169.254.169.254')
    expect(assertUrlShape('http://0177.0.0.1/').hostname).toBe('127.0.0.1')
    expect(assertUrlShape('http://0x7f.1/').hostname).toBe('127.0.0.1')
    expect(assertUrlShape('http://127.1/').hostname).toBe('127.0.0.1')

    for (const encoded of ['2852039166', '0177.0.0.1', '0x7f.1', '127.1']) {
      const url = assertUrlShape(`http://${encoded}/`)
      expect(() => assertAddressAllowed(url.hostname), encoded).toThrow(BlockedAddressError)
    }
  })

  it('refuses a bare hostname that is an encoded address, for callers that skip the URL parser', () => {
    // resolveAndCheck takes a hostname directly, so the same encodings must be refused there too
    // rather than relying on every caller having gone through `new URL` first.
    for (const host of ['2852039166', '0177.0.0.1', '0x7f.1', '127.1']) {
      expect(() => assertHostnameShape(host), host).toThrow(InvalidTargetError)
    }
    expect(() => assertHostnameShape('sonarr.lan')).not.toThrow()
    expect(() => assertHostnameShape('nas-01.home.arpa')).not.toThrow()
  })
})

describe('resolution', () => {
  it('checks a literal without touching DNS', async () => {
    const resolved = await resolveAndCheck('10.0.0.20')
    expect(resolved.addresses).toEqual([{ address: '10.0.0.20', family: 4 }])
  })

  it('refuses a literal in a blocked range before any socket is opened', async () => {
    await expect(resolveAndCheck('169.254.169.254')).rejects.toThrow(BlockedAddressError)
  })

  it('refuses a name that resolves to a blocked address', async () => {
    // localhost resolves to loopback, which is blocked unless explicitly allowed.
    await expect(resolveAndCheck('localhost')).rejects.toThrow(BlockedAddressError)
    await expect(resolveAndCheck('localhost', { allowLoopback: true })).resolves.toBeDefined()
  })
})

describe('pinnedLookup', () => {
  const resolved = {
    hostname: 'sonarr.lan',
    addresses: [
      { address: '10.0.0.20', family: 4 as const },
      { address: 'fd00::20', family: 6 as const },
    ],
  }

  it('returns the array form when Node asks for all, which is what the HTTP layer does', () => {
    // The three-argument callback form is rejected with "Invalid IP address: undefined" when
    // {all: true} is passed. The failure mode is "every widget errors", which invites someone to
    // delete the custom lookup and take the rebinding defence with it.
    const lookup = pinnedLookup(resolved)
    let received: unknown
    lookup('sonarr.lan', { all: true }, (error, value) => {
      expect(error).toBeNull()
      received = value
    })
    expect(received).toEqual([
      { address: '10.0.0.20', family: 4 },
      { address: 'fd00::20', family: 6 },
    ])
  })

  it('returns the three-argument form when Node does not ask for all', () => {
    const lookup = pinnedLookup(resolved)
    const seen: unknown[] = []
    lookup('sonarr.lan', {}, (error, address, family) => seen.push(error, address, family))
    expect(seen).toEqual([null, '10.0.0.20', 4])
  })

  it('honours a requested family but never invents an address outside the pinned set', () => {
    const lookup = pinnedLookup(resolved)
    let received: { address: string }[] = []
    lookup('sonarr.lan', { all: true, family: 6 }, (_e, value) => {
      received = value as { address: string }[]
    })
    expect(received).toEqual([{ address: 'fd00::20', family: 6 }])
  })

  it('ignores the hostname it is given — the pin is the point', () => {
    // A rebinding attack changes what the name resolves to between check and connect. There is
    // no second resolution to poison because this never consults DNS at all.
    const lookup = pinnedLookup(resolved)
    let received: { address: string }[] = []
    lookup('evil.example.com', { all: true }, (_e, value) => {
      received = value as { address: string }[]
    })
    expect(received.map((a) => a.address)).toEqual(['10.0.0.20', 'fd00::20'])
  })
})
