import { describe, expect, it } from 'vitest'
import type { Auth } from '@neohomepage/catalog-schema'
import { applyAuth, fillTemplate, MissingSecretError, redactHeaders } from './auth.ts'

const context = {
  secrets: { apiKey: 'SONARR-KEY', token: 'PVE-TOKEN', password: 'hunter2' },
  config: { username: 'admin', user: 'root@pam!neo' },
}

describe('templates', () => {
  it('fills a secret reference', () => {
    expect(fillTemplate('{{secret:apiKey}}', context)).toBe('SONARR-KEY')
  })

  it('fills a config reference', () => {
    expect(fillTemplate('{{config:username}}', context)).toBe('admin')
  })

  it('supports the composite form real services need', () => {
    // Proxmox wants `PVEAPIToken=root@pam!neo=<token>`, which is why `header` takes a value
    // template rather than being a bare secret slot.
    expect(fillTemplate('PVEAPIToken={{config:user}}={{secret:token}}', context)).toBe(
      'PVEAPIToken=root@pam!neo=PVE-TOKEN',
    )
  })

  it('throws for a missing secret instead of sending an empty credential', () => {
    expect(() => fillTemplate('{{secret:absent}}', context)).toThrow(MissingSecretError)
    expect(() =>
      fillTemplate('{{secret:apiKey}}', { ...context, secrets: { apiKey: '' } }),
    ).toThrow(MissingSecretError)
  })

  it('leaves unrecognised braces alone rather than guessing', () => {
    expect(fillTemplate('{{unknown:x}} {literal}', context)).toBe('{{unknown:x}} {literal}')
  })
})

describe('the five auth kinds', () => {
  it('none sends nothing', () => {
    expect(applyAuth({ kind: 'none' }, context)).toEqual({ headers: {}, query: {} })
  })

  it('header sends the named header', () => {
    const auth: Auth = { kind: 'header', header: 'X-Api-Key', value: '{{secret:apiKey}}' }
    expect(applyAuth(auth, context).headers).toEqual({ 'X-Api-Key': 'SONARR-KEY' })
  })

  it('basic encodes credentials the way HTTP expects', () => {
    const auth: Auth = {
      kind: 'basic',
      username: '{{config:username}}',
      password: '{{secret:password}}',
    }
    const applied = applyAuth(auth, context)
    expect(applied.headers.authorization).toBe(
      `Basic ${Buffer.from('admin:hunter2').toString('base64')}`,
    )
  })

  it('query puts the credential in the query string', () => {
    const auth: Auth = { kind: 'query', param: 'apikey', value: '{{secret:apiKey}}' }
    expect(applyAuth(auth, context).query).toEqual({ apikey: 'SONARR-KEY' })
  })

  it('session-exchange contributes nothing here, because it needs a login round trip first', () => {
    const auth: Auth = {
      kind: 'session-exchange',
      loginPath: '/api/auth',
      body: { password: '{{secret:password}}' },
      tokenPath: 'session.sid',
      sendAs: { kind: 'header', header: 'X-FTL-SID', value: '{{secret:sid}}' },
    }
    expect(applyAuth(auth, context)).toEqual({ headers: {}, query: {} })
  })
})

describe('redaction', () => {
  it('redacts by name for the headers auth produces', () => {
    const redacted = redactHeaders({
      authorization: 'Basic abc',
      cookie: 'sid=1',
      accept: 'application/json',
    })
    expect(redacted).toEqual({
      authorization: '[redacted]',
      cookie: '[redacted]',
      accept: 'application/json',
    })
  })

  it('redacts anything credential-shaped, because a manifest names its own header', () => {
    const redacted = redactHeaders({
      'X-Api-Key': 'k',
      'X-FTL-SID': 'sid',
      'X-Plex-Token': 't',
      'X-Custom-Secret': 's',
      'X-Widget-Password': 'p',
      'user-agent': 'neohomepage',
    })
    expect(redacted['X-Api-Key']).toBe('[redacted]')
    expect(redacted['X-FTL-SID']).toBe('[redacted]')
    expect(redacted['X-Plex-Token']).toBe('[redacted]')
    expect(redacted['X-Custom-Secret']).toBe('[redacted]')
    expect(redacted['X-Widget-Password']).toBe('[redacted]')
    expect(redacted['user-agent']).toBe('neohomepage')
  })

  it('never returns a secret value anywhere in its output', () => {
    const auth: Auth = { kind: 'header', header: 'X-Api-Key', value: '{{secret:apiKey}}' }
    const applied = applyAuth(auth, context)
    expect(JSON.stringify(redactHeaders(applied.headers))).not.toContain('SONARR-KEY')
  })
})
