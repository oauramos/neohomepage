import { describe, expect, it } from 'vitest'
import { themeSchema } from '../config/schema.ts'
import { themeVariables } from './theme.ts'

/**
 * `themeVariables` output lands in an inline `<style>`, so a `}` or `</style>` in a token value ends
 * the stylesheet. `config/theme.json` is hand-edited and `themeSchema` keeps unknown keys.
 */

const withVars = (cssVars: Record<string, Record<string, string>>) =>
  themeVariables(themeSchema.parse({ cssVars }))

describe('what reaches the stylesheet', () => {
  it('drops a value that could close the style element', () => {
    const css = withVars({ theme: { accent: '#000}</style><script>alert(1)</script>' } })
    expect(css).not.toContain('</style>')
    expect(css).not.toContain('<script>')
    // Falls back to the default rather than dropping the token.
    expect(css).toContain('--nh-accent:oklch(')
  })

  it('drops a name that is not a token this stylesheet consumes', () => {
    const css = withVars({ theme: { 'x:red}</style><script>x()</script>': 'red' } })
    expect(css).not.toContain('</style>')
    expect(css).not.toContain('--nh-x')
  })

  it('leaves every legitimate value untouched', () => {
    // Shadows are full of parentheses and commas; the guard must refuse, not escape.
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
    // None of these ends the element, so a blacklist aimed at `</style>` passes them; Chromium then
    // drops the rules that follow, including the grid CSS.
    const light = /:root\{([^}]*)\}/.exec(withVars({ light: { accent: value } }))?.[1] ?? ''
    const accent = light.split(';').find((declaration) => declaration.startsWith('--nh-accent:'))
    // Whole declaration: the default also contains "oklch(", so `not.toContain` would prove nothing.
    expect(accent).toBe('--nh-accent:oklch(0.54 0.19 258)')
  })

  it('drops a value that would make the published page fetch something', () => {
    // A remote image in a static page reports who is viewing it.
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
