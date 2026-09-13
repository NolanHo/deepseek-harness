/**
 * JobListAction phone badge: the `@media (max-width: 560px)` block that keeps
 * the background-job count on one line. The desktop `.count` declares no
 * `white-space`, so the label wraps onto ~4 lines and takes the header row
 * from ~30px to 78px with it. Every assertion is scoped to that media body;
 * the top-level rule scan used by the sibling style specs is brace-blind and
 * reports a `@media` prelude as if it were a selector over the whole file.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  fileURLToPath(new URL('../src/client/JobListAction.module.css', import.meta.url)),
  'utf8',
)

/** Prelude of the phone regime (spec: the badge narrows and ellipsizes, never wraps or grows). */
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
  expect(phone, `${PHONE_PRELUDE} is missing from JobListAction.module.css`).toBeDefined()
  const found = declarationsIn(phone as string, selector)
  expect(found, `${selector} is not declared inside ${PHONE_PRELUDE}`).toBeDefined()
  return found as Map<string, string>
}

/**
 * Whether a declared width is a zero one, either spelling.
 * @param value - the declared value, or undefined when the property is absent.
 * @returns true when the value carries no width.
 */
function isZeroWidth(value: string | undefined): boolean {
  return value === '0' || value === '0px'
}

/**
 * Whether a declared width is a bound relative to the containing block rather
 * than a fixed length: a percentage, a font/viewport-relative unit, or a
 * length function built from one.
 * @param value - the declared value, or undefined when the property is absent.
 * @returns true when the value bounds the box against its container.
 */
function isRelativeWidth(value: string | undefined): boolean {
  if (value === undefined) return false
  return /%|\b(?:em|rem|ch|ex|ic|lh|rlh|vw|vh|vmin|vmax|svw|svh|lvw|lvh|dvw|dvh)\b|\b(?:calc|min|max|clamp)\(/
    .test(value)
}

/**
 * Shrink factor of a `flex` shorthand, including the components it omits.
 * @param flex - the shorthand text.
 * @returns the shrink factor as declared, or as defaulted by the shorthand.
 */
function flexShrinkOf(flex: string): string {
  const parts = flex.trim().split(/\s+/)
  // `none` is 0 0 auto; every other shorthand defaults an omitted shrink to 1.
  if (parts[0] === 'none') return '0'
  return parts[1] ?? '1'
}

describe('JobListAction.module.css phone badge', () => {
  it('declares the phone regime for viewports up to 560px', () => {
    expect(phone, `${PHONE_PRELUDE} is missing from JobListAction.module.css`).toBeDefined()
  })

  it('keeps the count label on one line and ellipsizes it', () => {
    const count = phoneDeclarations('.count')
    expect(count.get('white-space'),
      '.count must not wrap: the wrapped "9 background jobs" label grew the phone header row to 78px')
      .toBe('nowrap')
    expect(['overflow', 'overflow-x'].some(property => count.get(property) === 'hidden'),
      '.count needs a clipping box (overflow: hidden or overflow-x: hidden) for the ellipsis to render')
      .toBe(true)
    expect(count.get('text-overflow'), '.count must ellipsize the label it clips').toBe('ellipsis')
  })

  it('lets the badge boxes shrink instead of pushing the row wider', () => {
    expect(isZeroWidth(phoneDeclarations('.root').get('min-width')),
      '.root needs min-width: 0 so the badge shrinks inside the phone header actions')
      .toBe(true)
    expect(isZeroWidth(phoneDeclarations('.trigger').get('min-width')),
      '.trigger needs min-width: 0 so the nowrap count can ellipsize instead of widening the row')
      .toBe(true)
  })

  it('bounds the badge so it narrows instead of overflowing the row', () => {
    const trigger = phoneDeclarations('.trigger')
    const bound = trigger.get('max-width') ?? trigger.get('width')
    // `.trigger` is an inline-flex box inside the shrinking `.root`: without a
    // width bound its shrink-to-fit resolves to the nowrap label's min-content
    // and it overflows the containing block instead of narrowing, so the
    // ellipsis above never engages.
    expect(isRelativeWidth(bound),
      '.trigger must declare a width bound relative to its containing block (`max-width: 100%`, or a '
      + 'width/max-width in relative units): unbounded, the inline-flex trigger grows past the shrunk '
      + '`.root` and the badge overflows the phone header row (declared max-width: '
      + `${trigger.get('max-width')}, width: ${trigger.get('width')})`)
      .toBe(true)

    const count = phoneDeclarations('.count')
    const flex = count.get('flex')
    const shrink = count.get('flex-shrink') ?? (flex === undefined ? undefined : flexShrinkOf(flex))
    // A flex item defaults to `min-width: auto`, so the nowrap label keeps its
    // full min-content width and the clipping box has nothing to ellipsize.
    expect(isZeroWidth(count.get('min-width')) || shrink === '1',
      '.count must declare min-width: 0 (or flex-shrink: 1 / `flex: 0 1 auto`) so the nowrap label can '
      + 'narrow below its min-content width and the ellipsis engages (declared min-width: '
      + `${count.get('min-width') ?? 'unset, i.e. auto'}, flex: ${count.get('flex') ?? 'unset'})`)
      .toBe(true)
  })

  it('never clips the popover box', () => {
    // `.menu` is absolutely positioned inside `.root`, so a hidden overflow on
    // this box removes the job list from every phone viewport — the module's
    // own version of the conversation `.headerActions` guard one level in.
    const root = phoneDeclarations('.root')
    for (const property of ['overflow', 'overflow-x', 'overflow-y']) {
      expect(root.get(property),
        `.root ${property} must not be hidden: the job menu is absolutely positioned inside this box`)
        .not.toBe('hidden')
    }
  })
})
