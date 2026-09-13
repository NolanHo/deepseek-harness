/**
 * ConversationRoot phone header: the `@media (max-width: 560px)` block measured
 * to leave the corner control 4px past the viewport and to hide the session
 * title at 360/412/480/560. Assertions are scoped to that media body; the
 * top-level rule scan used by the sibling style specs is brace-blind and
 * reports a `@media` prelude as if it were a selector over the whole file —
 * this file also carries a `max-width: 767.98px` block that must not be read.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  fileURLToPath(new URL('../src/client/skeleton/ConversationRoot.module.css', import.meta.url)),
  'utf8',
)

/** Prelude of the phone regime (spec: title restored, corner pulled inboard). */
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

/** Slot key whose mount anchor (`data-slot`) renders inside `.crumbs`. */
const LINEAGE_SLOT = "[data-slot='conversation.session.header.lineage']"

/** One parsed rule: the entries of its selector list and their declarations. */
interface CssRule {
  selectors: string[]
  declarations: Map<string, string>
}

/**
 * Every rule of a rule body, with `:global(...)` unwrapped and quotes and
 * spacing normalized so a selector reads the way it targets the DOM.
 * @param body - the rule body text to scan, already scoped to the media block.
 * @returns the parsed rules, in source order.
 */
function rulesIn(body: string): CssRule[] {
  const withoutComments = body.replace(/\/\*[\s\S]*?\*\//g, ' ')
  const rules: CssRule[] = []
  for (const [, selectorList = '', block = ''] of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declarations = new Map<string, string>()
    for (const part of block.split(';')) {
      const colon = part.indexOf(':')
      if (colon === -1) continue
      declarations.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim().replace(/\s+/g, ' '))
    }
    rules.push({
      selectors: selectorList.split(',').map(value => value.trim()
        .replace(/:global\(([^()]*)\)/g, '$1')
        .replace(/"/g, "'")
        .replace(/\s+/g, ' ')),
      declarations,
    })
  }
  return rules
}

/**
 * Subject compound of one selector entry: the part after its last combinator.
 * @param selector - one entry of a selector list.
 * @returns the compound the rule styles.
 */
function subjectCompound(selector: string): string {
  return selector.split(/[\s>+~]+/).filter(Boolean).pop() ?? ''
}

const phone = mediaBody(PHONE_PRELUDE)

/**
 * Declarations of one exact selector inside the phone block.
 * @param selector - exact selector text.
 * @returns the normalized declarations.
 */
function phoneDeclarations(selector: string): Map<string, string> {
  expect(phone, `${PHONE_PRELUDE} is missing from ConversationRoot.module.css`).toBeDefined()
  const found = declarationsIn(phone as string, selector)
  expect(found, `${selector} is not declared inside ${PHONE_PRELUDE}`).toBeDefined()
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

describe('ConversationRoot.module.css phone header', () => {
  // This file already carries the phone block, so its presence is asserted by
  // `phoneDeclarations` inside every case rather than by a case of its own.
  it('never hides the lineage slot inside the breadcrumbs on phones', () => {
    expect(phone, `${PHONE_PRELUDE} is missing from ConversationRoot.module.css`).toBeDefined()
    // The slot stays: on a subagent session it renders the `switcher` variant,
    // whose trigger carries that session's own title, and it is the only phone
    // entry point into the subagent catalog (the drawer tree and the session
    // search both filter `origin === 'subagent'` out). Hiding it on phones
    // deleted the subagent title and the catalog entry together, so no rule of
    // this block may hide it again. The mount carries `data-slot` (ui-renderer
    // scoped-slots.tsx); `rulesIn` unwraps `:global(...)` and normalizes both
    // quote styles, so any spelling of the hider is caught.
    const hiders = rulesIn(phone as string).filter(rule =>
      /^none\b/i.test(rule.declarations.get('display') ?? '')
      && rule.selectors.some(selector => selector.includes(LINEAGE_SLOT)),
    )
    expect(hiders.map(rule => rule.selectors.join(', ')),
      `${PHONE_PRELUDE} must not hide the lineage slot mount (${LINEAGE_SLOT}) with display: none: it `
      + "carries the subagent session's own title and is the only phone entry point into the subagent catalog")
      .toEqual([])
  })

  it('shows the session title breadcrumbs again with a width floor', () => {
    const crumbs = phoneDeclarations('.crumbs')
    expect(crumbs.get('display'), '.crumbs must not be hidden on phones').not.toBe('none')
    // The floor is what keeps the title readable while the actions shrink; the
    // title itself truncates through `.crumb`'s existing ellipsis.
    expect(px(crumbs, 'min-width'), '.crumbs needs a min-width floor so the title survives')
      .toBeGreaterThanOrEqual(88)
  })

  it('lets the header actions shrink instead of overflowing the row', () => {
    const actions = phoneDeclarations('.headerActions')
    const flex = actions.get('flex')
    const shrink = actions.get('flex-shrink') ?? (flex === undefined ? undefined : flexShrinkOf(flex))
    expect(shrink, '.headerActions must be allowed to shrink below its content width').toBe('1')
    expect(actions.get('min-width') === '0' || actions.get('overflow') === 'hidden'
      || actions.get('overflow-x') === 'hidden',
    '.headerActions needs min-width: 0 or overflow: hidden to shrink').toBe(true)
  })

  it('never clips the actions box that holds the job popover (regression guard, not a RED assertion)', () => {
    const actions = phoneDeclarations('.headerActions')
    // The job badge's menu is absolutely positioned inside `.headerActions`, so
    // a hidden overflow here removes the popover from every phone viewport:
    // the phone block may let the box shrink, never clip it.
    for (const property of ['overflow', 'overflow-x', 'overflow-y']) {
      expect(actions.get(property),
        `.headerActions ${property} must not be hidden: the job menu is absolutely positioned `
        + 'inside this box, so clipping makes the popover invisible on every <=560px viewport')
        .not.toBe('hidden')
    }
    // Regression guard, not a RED assertion: this scan passes on the tree
    // before the change as well as on the current one, because no phone rule
    // ever declared an overflow on `.headerActions`. It stays so a later phone
    // rule cannot reintroduce the clipping: the same guard over every rule of
    // the phone block catches a compound or descendant selector reaching this
    // box exactly as the bare selector above does.
    const clippers = rulesIn(phone as string).filter(rule =>
      ['overflow', 'overflow-x', 'overflow-y'].some(property => rule.declarations.get(property) === 'hidden')
      && rule.selectors.some(selector => /\.headerActions(?![\w-])/.test(subjectCompound(selector))))
    expect(clippers.map(rule => rule.selectors.join(', ')),
      'no phone rule may clip `.headerActions`: the job popover is absolutely positioned inside it')
      .toEqual([])
  })

  it('pulls the corner control back inside the phone header padding', () => {
    // The desktop -16px margin is tuned for the 28px right padding; at the
    // phone 12px padding it lands the control 4px past the viewport.
    const corner = phoneDeclarations('.headerCorner')
    expect(['0', '0px'], '.headerCorner must stop reaching past the 12px phone padding')
      .toContain(corner.get('margin-right'))
    // Regression guard: the phone block already owns this padding and keeps it.
    expect(phoneDeclarations('.header').get('padding')).toBe('8px 12px 0 56px')
  })
})
