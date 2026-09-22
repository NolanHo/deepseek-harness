/**
 * JobListAction phone badge: the `@media (max-width: 560px)` block that replaces
 * the localized count label with the bare count. The desktop label ("4
 * background jobs") truncates to "4 bac…" in the phone header row and spends the
 * width the session title needs. Every assertion is scoped to that media body;
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

/** Prelude of the phone regime (spec: the badge shows the count alone). */
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

describe('JobListAction.module.css phone badge', () => {
  it('drops the label words on phones and keeps the count alone', () => {
    // The full localized label ("4 background jobs") truncates to "4 bac…" in
    // the phone row and spends the width the session title needs; the badge
    // renders the count in its own span and this block hides the label.
    expect(phoneDeclarations('.count').get('display'),
      '.count must not render in the phone row: the truncated label takes the session title’s width')
      .toBe('none')
    expect(phoneDeclarations('.countCompact').get('display'),
      '.countCompact must render in the phone row so the badge still shows how many jobs run')
      .toBe('inline')
  })

  it('keeps the count-only span out of the desktop badge', () => {
    expect(declarationsIn(css, '.countCompact')?.get('display'),
      'the compact count is a phone presentation: the desktop badge keeps the full localized label')
      .toBe('none')
  })

  it('lets the badge boxes shrink instead of pushing the row wider', () => {
    expect(isZeroWidth(phoneDeclarations('.root').get('min-width')),
      '.root needs min-width: 0 so the badge shrinks inside the phone header actions')
      .toBe(true)
    expect(isZeroWidth(phoneDeclarations('.trigger').get('min-width')),
      '.trigger needs min-width: 0 so the badge shrinks inside the phone header actions')
      .toBe(true)
  })

  it('bounds the badge so it narrows instead of overflowing the row', () => {
    const trigger = phoneDeclarations('.trigger')
    const bound = trigger.get('max-width') ?? trigger.get('width')
    // `.trigger` is an inline-flex box inside the shrinking `.root`: without a
    // width bound its shrink-to-fit resolves to its content's min-content width
    // and it overflows the containing block instead of narrowing.
    expect(isRelativeWidth(bound),
      '.trigger must declare a width bound relative to its containing block (`max-width: 100%`, or a '
      + 'width/max-width in relative units): unbounded, the inline-flex trigger grows past the shrunk '
      + '`.root` and the badge overflows the phone header row (declared max-width: '
      + `${trigger.get('max-width')}, width: ${trigger.get('width')})`)
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
