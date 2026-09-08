import { describe, expect, it } from 'vitest'
import { themeSchema } from '../config/schema.ts'
import { themeVariables } from './theme.ts'

/**
 * The sink.
 *
 * `themeVariables` builds `--nh-<name>:<value>` and the publish step drops the result into an
 * inline `<style>`. A `}` or a `</style>` in a token value is therefore not a malformed
 * declaration — it is the end of the stylesheet and the start of whatever the value says next.
 *
 * Nothing in the app writes such a value: the design panel converts colours itself, and the MCP
 * design tools only emit members of closed tables. But `config/theme.json` is a file a person
 * edits, `themeSchema` keeps unknown keys on purpose, and the point of a guard at the sink is that
 * it holds when the thing upstream of it changes.
 */

const withVars = (cssVars: Record<string, Record<string, string>>) =>
  themeVariables(themeSchema.parse({ cssVars }))

describe('what reaches the stylesheet', () => {
  it('drops a value that could close the style element', () => {
    const css = withVars({ theme: { accent: '#000}</style><script>alert(1)</script>' } })
    expect(css).not.toContain('</style>')
    expect(css).not.toContain('<script>')
    // And the token still has its normal value from the defaults, rather than nothing at all.
    expect(css).toContain('--nh-accent:oklch(')
  })

  it('drops a name that is not a token this stylesheet consumes', () => {
    const css = withVars({ theme: { 'x:red}</style><script>x()</script>': 'red' } })
    expect(css).not.toContain('</style>')
    expect(css).not.toContain('--nh-x')
  })

  it('leaves every legitimate value untouched', () => {
    // The values a preset or a finish carries are full of parentheses, commas and percentages —
    // a guard that escaped them, rather than refusing the characters that end a declaration,
    // would break every shadow in the repository.
    const css = withVars({
      theme: { shadow: '0 1px 2px color-mix(in oklch,var(--nh-foreground) 8%,transparent)' },
    })
    expect(css).toContain(
      '--nh-shadow:0 1px 2px color-mix(in oklch,var(--nh-foreground) 8%,transparent)',
    )
  })

  it.each([
    ['an unclosed string', '"x'],
    ['an unclosed single-quoted string', "'x"],
    ['a comment opener', 'oklch(0.5 0.1 30) /* eat the rest'],
    ['a dangling bracket', 'oklch('],
  ])('drops %s, which would swallow every declaration after it', (_label, value) => {
    // The quiet half of the problem. None of these contains a character that ends the ELEMENT, so
    // a blacklist aimed at `</style>` passes them; in Chromium each one took four rules with it,
    // including the emitted grid CSS that positions every tile.
    const light = /:root\{([^}]*)\}/.exec(withVars({ light: { accent: value } }))?.[1] ?? ''
    const accent = light.split(';').find((declaration) => declaration.startsWith('--nh-accent:'))
    // Compared as the whole declaration rather than as a substring search: a legitimate value
    // contains "oklch(" too, so `not.toContain` would pass on the default and prove nothing.
    // The token falls back to that default rather than disappearing, so the page stays whole.
    expect(accent).toBe('--nh-accent:oklch(0.54 0.19 258)')
  })

  it('drops a value that would make the published page fetch something', () => {
    // A token value has never needed a URL, and a static page that fetches a remote image is a
    // page that tells someone else who is looking at it.
    const css = withVars({ theme: { 'link-bg': 'url(http://tracker.example/pixel.png)' } })
    expect(css).not.toContain('tracker.example')
  })

  it('escapes an image path so it cannot leave the url()', () => {
    const css = themeVariables(
      themeSchema.parse({ surface: { background: '/a.png</style><script>x()</script>' } }),
    )
    expect(css).not.toContain('</style>')
    expect(css).toContain('background-image:url(')
  })
})
