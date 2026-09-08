import { describe, expect, it } from 'vitest'
import {
  BOARD_WIDTHS,
  COLOUR_GROUPS,
  FONT_STACKS,
  SHAPE_RESET_TOKENS,
  TITLE_CASES,
  TYPE_RESET_TOKENS,
  boardWidthById,
  boardWidthOf,
  fontStackById,
  fontStackOf,
  titleCaseById,
} from './design-options.ts'
import { SHAPE_TOKENS } from './theme-presets.ts'
import { THEME_TOKENS } from './theme-tokens.ts'

/**
 * The option tables, held to the two claims their comments make.
 *
 * Both are claims about coverage, and coverage is exactly what goes wrong quietly: a token added
 * to the contract and to neither reset is a value a "Reset to the preset" button leaves behind,
 * and a colour token no group names is one the panel cannot edit and the design tools cannot
 * explain. Neither shows up as a crash.
 */

describe('the reset partition', () => {
  // Only one of these two lists is authored: `SHAPE_RESET_TOKENS` is the complement of
  // `TYPE_RESET_TOKENS` inside `SHAPE_TOKENS`, which is what makes "covers everything" true by
  // construction rather than by test. What a test CAN catch is the authored half drifting — a
  // renamed or removed token still named as a type reset, which would silently shrink the shape
  // reset by one and leave a value the Type tab claims to undo.
  it('names only tokens that exist', () => {
    for (const token of TYPE_RESET_TOKENS) expect(SHAPE_TOKENS).toContain(token)
  })

  it('leaves the two halves disjoint and complete', () => {
    const combined = [...SHAPE_RESET_TOKENS, ...TYPE_RESET_TOKENS].sort()
    expect(new Set(combined).size).toBe(combined.length)
    expect(combined).toEqual([...SHAPE_TOKENS].sort())
  })
})

describe('the colour groups', () => {
  it('name every colour token in the contract, and nothing else', () => {
    const named = COLOUR_GROUPS.flatMap((group) => group.tokens.map((token) => token.name))
    expect(named.sort()).toEqual([...THEME_TOKENS].sort())
  })

  it('give every token a label a person could act on', () => {
    for (const group of COLOUR_GROUPS) {
      for (const token of group.tokens) expect(token.label.length).toBeGreaterThan(2)
    }
  })
})

describe('the lookups', () => {
  it.each(FONT_STACKS.map((stack) => stack.id))('%s round-trips', (id) => {
    expect(fontStackOf(fontStackById(id)?.value)?.id).toBe(id)
  })

  it.each(BOARD_WIDTHS.map((width) => width.id))('%s round-trips', (id) => {
    expect(boardWidthOf(boardWidthById(id)?.value)?.id).toBe(id)
  })

  it('answers null for a width no option names, rather than the nearest one', () => {
    // A finish can ship 1500px. Reporting that as "comfortable" would make a read-then-write
    // round trip through the design tools silently retype the board.
    expect(boardWidthOf('1500px')).toBeUndefined()
  })

  it.each(TITLE_CASES.map((entry) => entry.id))('%s sets both of its tokens', (id) => {
    const tokens = titleCaseById(id)?.tokens ?? {}
    expect(Object.keys(tokens).sort()).toEqual(['title-tracking', 'title-transform'])
  })
})
