/**
 * SettingsRoot phone presentation: the `@media (max-width: 560px)` block that
 * turns the centered desktop dialog into a full-screen single column with a
 * horizontal nav rail. Every assertion is scoped to that media body; the
 * top-level rule scan used by the sibling style specs is brace-blind and
 * reports a `@media` prelude as if it were a selector over the whole file.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/SettingsRoot.module.css', import.meta.url)), 'utf8')

/** Prelude of the phone regime (spec: mask + panel cover the viewport). */
const PHONE_PRELUDE = '@media (max-width: 560px)'

/**
 * Body of one at-rule, located by its exact prelude and closed by brace balance.
 * @param prelude - exact at-rule prelude, e.g. `@media (max-width: 560px)`.
 * @returns the wrapped text, or undefined when the prelude is absent.
 */
function mediaBody(prelude: string): string | undefined {
  const start = css.indexOf(prelude)
  if (start === -1) return undefined
  const open = css.indexOf('{', start + prelude.length)
  if (open === -1) return undefined
  let depth = 0
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1
    else if (css[index] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(open + 1, index)
    }
  }
  return undefined
}

/**
 * Declarations of one exact selector inside a rule body, keyed by property.
 * @param body - the rule body text to scan, already scoped to the media block.
 * @param selector - exact selector text.
 * @returns the normalized declarations, or undefined when the selector is absent.
 */
function declarationsIn(body: string, selector: string): Map<string, string> | undefined {
  const withoutComments = body.replace(/\/\*[\s\S]*?\*\//g, ' ')
  for (const [, selectorList = '', rules = ''] of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectorList.split(',').map(value => value.trim()).includes(selector)) continue
    const found = new Map<string, string>()
    for (const part of rules.split(';')) {
      const colon = part.indexOf(':')
      if (colon === -1) continue
      found.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim().replace(/\s+/g, ' '))
    }
    return found
  }
  return undefined
}

const phone = mediaBody(PHONE_PRELUDE)

/**
 * Declarations of one exact selector inside the phone block.
 * @param selector - exact selector text.
 * @returns the normalized declarations.
 */
function phoneDeclarations(selector: string): Map<string, string> {
  expect(phone, `${PHONE_PRELUDE} is missing from SettingsRoot.module.css`).toBeDefined()
  const found = declarationsIn(phone as string, selector)
  expect(found, `${selector} is not declared inside ${PHONE_PRELUDE}`).toBeDefined()
  return found as Map<string, string>
}

/**
 * Declarations of one exact selector outside the phone block, i.e. the desktop
 * rule that still applies inside the media body wherever it stays silent.
 * @param selector - exact selector text.
 * @returns the normalized declarations.
 */
function baseDeclarations(selector: string): Map<string, string> {
  expect(phone, `${PHONE_PRELUDE} is missing from SettingsRoot.module.css`).toBeDefined()
  const found = declarationsIn(css.replace(phone as string, ' '), selector)
  expect(found, `${selector} is not declared outside ${PHONE_PRELUDE}`).toBeDefined()
  return found as Map<string, string>
}

/**
 * Pixels of the first declared length among `properties`.
 * @param declarations - declarations of one selector.
 * @param properties - property names in preference order.
 * @returns the numeric pixels, or NaN when none of them carries a px length.
 */
function px(declarations: Map<string, string>, ...properties: string[]): number {
  for (const property of properties) {
    const value = declarations.get(property)
    if (value === undefined) continue
    const match = /([\d.]+)px/.exec(value)
    if (match?.[1] !== undefined) return Number.parseFloat(match[1])
  }
  return Number.NaN
}

/**
 * Top and bottom pixels of one selector's padding, from the `padding`
 * shorthand or its `padding-top`/`padding-bottom` longhands.
 * @param declarations - declarations of one selector.
 * @returns the vertical paddings; either is NaN when no px length declares it.
 */
function verticalPadding(declarations: Map<string, string>): { top: number; bottom: number } {
  const sides = (declarations.get('padding') ?? '').split(/\s+/).filter(Boolean)
  // The shorthand repeats its values: 1 = all sides, 2 = block then inline,
  // 3 = top, inline, bottom, 4 = top, right, bottom, left.
  const pixels = (property: string, index: number): number => {
    const value = declarations.get(property) ?? sides[index] ?? sides[0] ?? ''
    const match = /^([\d.]+)px$/.exec(value)
    return match?.[1] === undefined ? Number.NaN : Number.parseFloat(match[1])
  }
  return {
    top: pixels('padding-top', 0),
    bottom: pixels('padding-bottom', sides.length >= 3 ? 2 : 0),
  }
}

describe('SettingsRoot.module.css phone block', () => {
  it('declares the phone regime for viewports up to 560px', () => {
    expect(phone, `${PHONE_PRELUDE} is missing from SettingsRoot.module.css`).toBeDefined()
  })

  it('makes the panel a full-screen column with no corner radius', () => {
    const panel = phoneDeclarations('.panel')
    expect(panel.get('flex-direction'), '.panel stacks the nav rail above the content').toBe('column')
    expect(['100%', '100vw'], '.panel width must fill the viewport').toContain(panel.get('width'))
    // The panel fills `.overlay` (`position: fixed; inset: 0`), whose box is the
    // visual viewport on phones, so `100%` tracks the space actually on screen.
    // `100vh` resolves against the large viewport (URL bar collapsed) and would
    // make the panel taller than the visible area — the defect this block fixes.
    expect(panel.get('height'),
      '.panel height must be 100% of the fixed inset: 0 overlay so it tracks the visual viewport; '
      + '100vh reintroduces the mobile large-viewport defect that pushes the panel past the URL bar')
      .toBe('100%')
    // The desktop `max-width: calc(100vw - 48px)` would otherwise keep the
    // panel 48px short of the viewport it is supposed to fill.
    expect(['100%', '100vw', 'none'], '.panel must drop the desktop max-width clamp')
      .toContain(panel.get('max-width'))
    expect(['0', '0px'], '.panel drops the desktop corner radius').toContain(panel.get('border-radius'))
  })

  it('turns the nav list into a horizontal scroller', () => {
    const navList = phoneDeclarations('.navList')
    expect(navList.get('flex-direction'), '.navList lays its cells along one row').toBe('row')
    expect(navList.get('overflow-x'), '.navList scrolls its cells horizontally').toBe('auto')
    const navCell = phoneDeclarations('.navCell')
    expect(['none', '0 0 auto'], '.navCell keeps its width inside the horizontal scroller')
      .toContain(navCell.get('flex'))
  })

  it('gives the close control the 36px thumb floor', () => {
    const close = phoneDeclarations('.close')
    expect(px(close, 'width', 'min-width'), '.close width must reach the 36px thumb floor')
      .toBeGreaterThanOrEqual(36)
    expect(px(close, 'height', 'min-height'), '.close height must reach the 36px thumb floor')
      .toBeGreaterThanOrEqual(36)
  })

  it('leaves the phone header tall enough to hold the close control', () => {
    // The block raises only the height, so the desktop padding and
    // `box-sizing: border-box` still apply inside it: the declared height is
    // the whole header box the control has to fit inside.
    const header = new Map([...baseDeclarations('.header'), ...phoneDeclarations('.header')])
    const { top, bottom } = verticalPadding(header)
    const closeHeight = px(phoneDeclarations('.close'), 'height', 'min-height')
    const needed = top + closeHeight + bottom
    expect(px(header, 'height', 'min-height'),
      `.header must fit the close control: ${top}px + ${closeHeight}px + ${bottom}px = ${needed}px`)
      .toBeGreaterThanOrEqual(needed)
  })
})
